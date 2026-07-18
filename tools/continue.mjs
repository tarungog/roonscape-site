#!/usr/bin/env node
// Voice-matched continuation pipeline.
//
//   node tools/continue.mjs <slug> [--notes "guidance for what comes next"]
//
// Finds the {{continue}} or {{continue: hint}} marker in drafts/<slug>.md
// (or continues from the end if absent). Samples candidate continuations from
// two frontier models — GPT-5.6 Sol (via codex CLI) and Claude Fable (via
// API) — then has a third (Claude Opus 4.8) judge which candidate is closest
// to the author's actual voice, grounded in voice/corpus.md.
//
// The winner is spliced into the draft (original backed up to .bak); every
// candidate + the judge's verdict land in drafts/<slug>.continuations.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
const ROOT = path.join(import.meta.dirname, "..");

// ---- args ----
const slug = process.argv[2];
if (!slug || slug.startsWith("--")) {
  console.error('usage: node tools/continue.mjs <slug> [--notes "..."]');
  process.exit(1);
}
const notesIdx = process.argv.indexOf("--notes");
const cliNotes = notesIdx > 0 ? process.argv[notesIdx + 1] : "";

const draftPath = path.join(ROOT, "drafts", `${slug}.md`);
if (!fs.existsSync(draftPath)) {
  console.error(`no draft at drafts/${slug}.md`);
  process.exit(1);
}
const corpusPath = path.join(ROOT, "voice", "corpus.md");
if (!fs.existsSync(corpusPath)) {
  console.error("no voice/corpus.md — run: node tools/voice.mjs");
  process.exit(1);
}

// ---- API key (same fallback as typeset.mjs) ----
if (!process.env.ANTHROPIC_API_KEY) {
  const somaEnv = path.join(ROOT, "..", "soma", ".env");
  if (fs.existsSync(somaEnv)) {
    const m = fs.readFileSync(somaEnv, "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].trim();
  }
}

// ---- locate the continuation point ----
const draft = fs.readFileSync(draftPath, "utf8");
const marker = draft.match(/\{\{continue(?::([\s\S]*?))?\}\}/);
const hint = (marker?.[1] ?? cliNotes ?? "").trim();
const before = marker ? draft.slice(0, marker.index) : draft;
const after = marker ? draft.slice(marker.index + marker[0].length) : "";

const corpus = fs.readFileSync(corpusPath, "utf8");

// ---- shared generation prompt ----
function genPrompt(variant) {
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

// ---- samplers ----
const client = new Anthropic();

async function sampleFable(variant) {
  const stream = client.beta.messages.stream({
    model: "claude-fable-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    messages: [{ role: "user", content: genPrompt(variant) }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("fable refused");
  return msg.content.find((b) => b.type === "text")?.text.trim() ?? "";
}

async function sampleSol(variant) {
  const outFile = path.join(os.tmpdir(), `sol-${slug}-${variant}-${process.pid}.md`);
  const prompt =
    genPrompt(variant) +
    "\n\n(You are being used as a text generator here: do not run commands, read files, or take any action. Your final message must be the continuation prose and nothing else.)";
  // Prompt goes via stdin ("-"), which we close immediately — codex otherwise
  // blocks forever on the dangling stdin pipe ("Reading additional input...").
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
    child.stdin.end(prompt);
  });
  const text = fs.readFileSync(outFile, "utf8").trim();
  fs.rmSync(outFile, { force: true });
  if (!text) throw new Error("sol returned empty output");
  return text;
}

console.log(`sampling candidates (fable x2, sol x2) for drafts/${slug}.md ...`);
const attempts = [
  { model: "fable", variant: "A", run: () => sampleFable("A") },
  { model: "fable", variant: "B", run: () => sampleFable("B") },
  { model: "sol", variant: "A", run: () => sampleSol("A") },
  { model: "sol", variant: "B", run: () => sampleSol("B") },
];
const settled = await Promise.allSettled(attempts.map((a) => a.run()));
const candidates = [];
settled.forEach((r, i) => {
  const { model, variant } = attempts[i];
  if (r.status === "fulfilled" && r.value) {
    candidates.push({ model, variant, text: r.value });
    console.log(`  ${model}-${variant}: ${r.value.length} chars`);
  } else {
    console.log(`  ${model}-${variant}: FAILED (${r.reason?.message ?? r.reason})`);
  }
});
if (candidates.length < 2) {
  console.error("fewer than 2 candidates — not enough to judge; aborting");
  process.exit(1);
}

// ---- judge: Opus 4.8, blind to which model wrote which ----
const shuffled = [...candidates].sort(() => Math.random() - 0.5);
shuffled.forEach((c, i) => (c.label = `C${i + 1}`));

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

console.log("judging (fable-5) ...");
const judgeStream = client.messages.stream({
  model: "claude-fable-5",
  max_tokens: 16000,
  output_config: {
    effort: "high",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          ranking: { type: "array", items: { type: "string" }, description: "candidate ids, best voice-match first" },
          rationale: { type: "string", description: "markdown: per-candidate verdicts with quoted evidence" },
        },
        required: ["ranking", "rationale"],
        additionalProperties: false,
      },
    },
  },
  messages: [{ role: "user", content: judgePrompt }],
});
const judgeMsg = await judgeStream.finalMessage();
const verdict = JSON.parse(judgeMsg.content.find((b) => b.type === "text")?.text ?? "{}");
const winner = shuffled.find((c) => c.label === verdict.ranking?.[0]) ?? shuffled[0];

// ---- write outputs ----
let report = `# Continuations — ${slug}\n\n`;
report += `Winner: **${winner.label} (${winner.model}-${winner.variant})** — ranking: ${verdict.ranking
  .map((l) => {
    const c = shuffled.find((x) => x.label === l);
    return `${l}=${c?.model}-${c?.variant}`;
  })
  .join(" > ")}\n\n## Judge rationale\n\n${verdict.rationale}\n\n## Candidates\n`;
for (const c of shuffled) {
  report += `\n### ${c.label} — ${c.model}-${c.variant}${c === winner ? " (WINNER)" : ""}\n\n${c.text}\n`;
}
fs.writeFileSync(path.join(ROOT, "drafts", `${slug}.continuations.md`), report);

fs.writeFileSync(`${draftPath}.bak`, draft);
const newDraft = marker
  ? draft.slice(0, marker.index) + winner.text + draft.slice(marker.index + marker[0].length)
  : draft.trimEnd() + "\n\n" + winner.text + "\n";
fs.writeFileSync(draftPath, newDraft);

console.log(`\nwinner: ${winner.model}-${winner.variant} (as ${winner.label})`);
console.log(`spliced into drafts/${slug}.md (backup: ${slug}.md.bak)`);
console.log(`all candidates + verdict: drafts/${slug}.continuations.md`);
