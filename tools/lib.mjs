// Shared pipeline library: voice-matched continuation sampling + judging.
// Used by the editor server; tools/continue.mjs is the CLI equivalent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

export const ROOT = path.join(import.meta.dirname, "..");

export function ensureKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const somaEnv = path.join(ROOT, "..", "soma", ".env");
    if (fs.existsSync(somaEnv)) {
      const m = fs.readFileSync(somaEnv, "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (m) process.env.ANTHROPIC_API_KEY = m[1].trim();
    }
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("no ANTHROPIC_API_KEY available");
}

export function loadCorpus() {
  const p = path.join(ROOT, "voice", "corpus.md");
  if (!fs.existsSync(p)) throw new Error("no voice/corpus.md — run: node tools/voice.mjs");
  return fs.readFileSync(p, "utf8");
}

function genPrompt(corpus, before, after, hint, variant) {
  return `You are ghostwriting a continuation for the author whose collected writing appears below. Your ONLY goal is to sound exactly like them — their cadence, capitalization habits, vocabulary, register shifts, and the way their arguments move.

<author_corpus>
${corpus}
</author_corpus>

<draft_so_far>
${before.trim()}
</draft_so_far>
${after.trim() ? `\n<what_comes_after>\n${after.trim()}\n</what_comes_after>\n(The continuation must bridge naturally into this later text.)\n` : ""}
${hint ? `AUTHOR'S NOTE on what comes next: ${hint}\n` : ""}
Write the natural continuation: 1-3 paragraphs unless the author's note implies otherwise. ${variant === "B" ? "Take a different tack than the most obvious continuation — a less expected but equally in-voice move." : "Take the most natural, in-voice continuation."}

Output ONLY the continuation prose. No preamble, no quotes around it, no commentary, no markdown headers.`;
}

async function sampleFable(client, prompt) {
  const stream = client.beta.messages.stream({
    model: "claude-fable-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("fable refused");
  return msg.content.find((b) => b.type === "text")?.text.trim() ?? "";
}

async function sampleSol(prompt) {
  const outFile = path.join(os.tmpdir(), `sol-${Date.now()}-${Math.floor(Math.random() * 1e6)}.md`);
  const fullPrompt =
    prompt +
    "\n\n(You are being used as a text generator here: do not run commands, read files, or take any action. Your final message must be the continuation prose and nothing else.)";
  await new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--skip-git-repo-check", "-o", outFile, "-"], {
      cwd: ROOT,
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 300_000,
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`codex exit ${code}: ${stderr.slice(-200)}`)),
    );
    child.stdin.end(fullPrompt);
  });
  const text = fs.readFileSync(outFile, "utf8").trim();
  fs.rmSync(outFile, { force: true });
  if (!text) throw new Error("sol returned empty output");
  return text;
}

// Local completion model: LoRA-tuned Llama-3.1-8B base on the author's corpus.
// True completion — the prompt is the draft itself, no instructions at all.
const ADAPTER = path.join(ROOT, "model", "adapters", "roon-8b");
const MLX = path.join(ROOT, "model", ".venv", "bin", "mlx_lm.generate");
export const localModelAvailable = () =>
  fs.existsSync(path.join(ADAPTER, "adapters.safetensors")) && fs.existsSync(MLX);

async function sampleRoonLocal(before, temp) {
  // completion prompt: last ~6k chars of the draft, ending exactly at the cursor
  const prompt = before.slice(-6000);
  const args = [
    "--model", "mlx-community/Meta-Llama-3.1-8B-4bit",
    "--adapter-path", ADAPTER,
    "--prompt", "-",
    "--max-tokens", "400",
    "--temp", String(temp),
  ];
  const out = await new Promise((resolve, reject) => {
    const child = spawn(MLX, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`mlx exit ${code}: ${stderr.slice(-200)}`)),
    );
    child.stdin.end(prompt);
  });
  // mlx_lm.generate wraps the completion in ========== fences
  const m = out.match(/==========\n([\s\S]*?)\n==========/);
  let text = (m ? m[1] : out).trim();
  // trim to the last complete paragraph so we don't hand back a mid-sentence tail
  const lastBreak = text.lastIndexOf("\n\n");
  if (lastBreak > 200) text = text.slice(0, lastBreak);
  if (!text) throw new Error("empty completion");
  return text.trim();
}

// Sample candidates (fable x2, sol x2, + roon-8b x2 when the adapter exists).
// onProgress(line) is optional.
export async function sampleCandidates({ before, after = "", hint = "", onProgress = () => {} }) {
  ensureKey();
  const corpus = loadCorpus();
  const client = new Anthropic();
  const attempts = [
    { model: "fable", variant: "A", run: () => sampleFable(client, genPrompt(corpus, before, after, hint, "A")) },
    { model: "fable", variant: "B", run: () => sampleFable(client, genPrompt(corpus, before, after, hint, "B")) },
    { model: "sol", variant: "A", run: () => sampleSol(genPrompt(corpus, before, after, hint, "A")) },
    { model: "sol", variant: "B", run: () => sampleSol(genPrompt(corpus, before, after, hint, "B")) },
  ];
  let roonQueue = Promise.resolve();
  if (localModelAvailable()) {
    // the local model runs serially (one GPU); sampled at two temperatures.
    // It sees no hint and no instructions — pure continuation of the draft.
    attempts.push({
      model: "roon-8b",
      variant: "A",
      run: () => roonQueue = roonQueue.then(() => sampleRoonLocal(before, 0.8)),
    });
    attempts.push({
      model: "roon-8b",
      variant: "B",
      run: () => roonQueue = roonQueue.then(() => sampleRoonLocal(before, 1.0)),
    });
  }
  const settled = await Promise.allSettled(
    attempts.map((a) =>
      a.run().then(
        (text) => {
          onProgress(`${a.model}-${a.variant}: ${text.length} chars`);
          return text;
        },
        (err) => {
          onProgress(`${a.model}-${a.variant}: FAILED (${err.message})`);
          throw err;
        },
      ),
    ),
  );
  const candidates = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value)
      candidates.push({ model: attempts[i].model, variant: attempts[i].variant, text: r.value });
  });
  return candidates;
}

// Blind judge (Fable) — returns { ranking, rationale, winnerIndex } over the
// candidates array as passed (indices refer to it).
export async function judgeCandidates({ before, candidates, onProgress = () => {} }) {
  ensureKey();
  const corpus = loadCorpus();
  const client = new Anthropic();

  const shuffled = candidates
    .map((c, i) => ({ ...c, index: i }))
    .sort(() => Math.random() - 0.5);
  shuffled.forEach((c, i) => (c.label = `C${i + 1}`));
  onProgress("judging (fable-5) ...");

  const judgePrompt = `You are judging which candidate continuation best matches an author's voice.

<author_corpus>
${corpus}
</author_corpus>

<draft_so_far>
${before.trim()}
</draft_so_far>

CANDIDATE CONTINUATIONS:
${shuffled.map((c) => `<candidate id="${c.label}">\n${c.text}\n</candidate>`).join("\n\n")}

Judge purely on fidelity to the author's voice as evidenced in the corpus: cadence, diction, capitalization habits, how their arguments move, what they would and wouldn't say. Not on which is "best writing" by generic standards — on which is most *them*. Quote specific phrases as evidence.`;

  const stream = client.messages.stream({
    model: "claude-fable-5",
    max_tokens: 16000,
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            ranking: { type: "array", items: { type: "string" } },
            rationale: { type: "string" },
          },
          required: ["ranking", "rationale"],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: "user", content: judgePrompt }],
  });
  const msg = await stream.finalMessage();
  const verdict = JSON.parse(msg.content.find((b) => b.type === "text")?.text ?? "{}");
  const byLabel = Object.fromEntries(shuffled.map((c) => [c.label, c]));
  const rankingIndices = (verdict.ranking ?? []).map((l) => byLabel[l]?.index).filter((i) => i != null);
  return {
    rationale: verdict.rationale ?? "",
    ranking: rankingIndices,
    winnerIndex: rankingIndices[0] ?? 0,
    labels: Object.fromEntries(shuffled.map((c) => [c.index, c.label])),
  };
}
