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

// ---- thinking engine: critique + ideation ----
// Fable and Sol used for what they're best at — thought, critique, ideation.
// Many samples, deliberate token spend, synthesis at the end.

async function fableThink(prompt) {
  ensureKey();
  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: "claude-fable-5",
    max_tokens: 16000,
    output_config: { effort: "high" },
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("fable refused");
  return msg.content.find((b) => b.type === "text")?.text.trim() ?? "";
}

const solThink = (prompt) => sampleSol(prompt);

const CRITIC_LEVELS = {
  essay: (draft) => `You are a ruthless editor. Critique this essay draft at the ESSAY level only: the argument's architecture. Where is the thesis strongest and weakest? What beat is missing? What should be cut entirely? Where does the ordering fight the argument? Identify the 3 strongest things (so they don't get edited away) and the 3 biggest structural problems. Be adversarial; do not flatter; do not line-edit.

<draft>
${draft}
</draft>`,
  paragraph: (draft) => `You are a ruthless editor. Critique this essay draft at the PARAGRAPH level only. For each paragraph: does it earn its place? where does it sag? does its opening move repeat the previous paragraph's? are the transitions doing work or just adjacency? Quote the first few words of each paragraph you discuss so the author can find it. Do not restructure the whole essay and do not line-edit sentences.

<draft>
${draft}
</draft>`,
  sentence: (draft) => `You are a ruthless line editor with a specific brief: hunt LLM-flavored prose. Quote exact sentences that are weak, cliché, or machine-scented — contrastive parallelism ("not X but Y"), tricolon escalation, aphorism-landing paragraph closers, tidy "this is the quiet mechanism by which..." moves, over-balanced clauses. For each: quote it, name the tic, and describe the MOVE that would fix it (cut, break the symmetry, bury the point mid-sentence, etc.). Do NOT write replacement prose — the author writes their own sentences. Also flag any factually shaky claims.

<draft>
${draft}
</draft>`,
};

export async function critiqueDraft({ draft, onProgress = () => {} }) {
  const passes = [];
  for (const [level, tmpl] of Object.entries(CRITIC_LEVELS)) {
    for (const [model, run] of [["fable", fableThink], ["sol", solThink]]) {
      passes.push(
        run(tmpl(draft)).then(
          (text) => {
            onProgress(`${model}/${level}: done (${text.length} chars)`);
            return { model, level, text };
          },
          (e) => {
            onProgress(`${model}/${level}: FAILED (${e.message})`);
            return null;
          },
        ),
      );
    }
  }
  const reports = (await Promise.all(passes)).filter(Boolean);
  if (!reports.length) throw new Error("all critique passes failed");

  onProgress("synthesizing (fable) ...");
  const synthesis = await fableThink(`Six independent editorial reports on the same draft follow (two models x three levels: essay, paragraph, sentence). Merge them into ONE report the author will actually use:
- Dedupe. Where reports agree, say so once (agreement is signal — mark it).
- Keep only the strongest critiques; kill weak or generic notes.
- Organize by level: ESSAY, then PARAGRAPH, then SENTENCE. Quote the text each item targets.
- End with "TOP 3 PRIORITIES" — the three changes worth making first.
- Critique and moves only; never draft replacement prose in the author's voice.

<draft>
${draft}
</draft>

${reports.map((r) => `<report model="${r.model}" level="${r.level}">\n${r.text}\n</report>`).join("\n\n")}`);
  return { synthesis, reports };
}

export async function ideate({ context, question, onProgress = () => {} }) {
  const round1Prompt = (m) => `${context ? `CONTEXT (a draft in progress):\n<draft>\n${context}\n</draft>\n\n` : ""}QUESTION: ${question}

Generate exactly 10 distinct ideas answering this question. Number them. One short paragraph each — the idea itself plus why it might work. Range widely; don't converge.`;

  onProgress("round 1: 10 ideas each from fable + sol ...");
  const [f1, s1] = await Promise.all([
    fableThink(round1Prompt("fable")),
    solThink(round1Prompt("sol")).catch((e) => {
      onProgress(`sol round 1 FAILED (${e.message})`);
      return null;
    }),
  ]);

  const pool1 = [f1, s1].filter(Boolean).join("\n\n");
  const round2Prompt = `${context ? `CONTEXT (a draft in progress):\n<draft>\n${context}\n</draft>\n\n` : ""}QUESTION: ${question}

Below are ${s1 ? 20 : 10} ideas already generated for this question. Treat ALL of them as the obvious first-pass answers — the ones any strong model produces on the first try. REJECT the entire pool. Then generate 10 NEW ideas that are structurally different: different frame, different scale, different move. Non-obvious but genuinely good — weird-but-defensible beats safe-but-stale. Number them and give one short paragraph each.

<rejected_pool>
${pool1}
</rejected_pool>`;

  onProgress("round 2: reject the obvious, 10 more each ...");
  const [f2, s2] = await Promise.all([
    fableThink(round2Prompt),
    solThink(round2Prompt).catch((e) => {
      onProgress(`sol round 2 FAILED (${e.message})`);
      return null;
    }),
  ]);

  onProgress("selection: picking the best across all rounds ...");
  const selection = await fableThink(`${context ? `CONTEXT (a draft in progress):\n<draft>\n${context}\n</draft>\n\n` : ""}QUESTION: ${question}

Up to 40 candidate ideas follow, from two models across two rounds (round 2 was forced to reject round 1 as too obvious). Pick the 5 BEST ideas overall — judged on originality, defensibility, and fit to the question and context. Round-2 ideas are not automatically better; an obvious idea executed perfectly can beat a clever one. For each pick: restate the idea sharply in 1-2 sentences, tag its provenance (model/round), and say why it beats its neighbors. Then give one line on the strongest idea you REJECTED and why it just missed.

<round1_fable>${f1 ?? "(failed)"}</round1_fable>
<round1_sol>${s1 ?? "(failed)"}</round1_sol>
<round2_fable>${f2 ?? "(failed)"}</round2_fable>
<round2_sol>${s2 ?? "(failed)"}</round2_sol>`);

  return { selection, rounds: { f1, s1, f2, s2 } };
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
