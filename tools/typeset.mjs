#!/usr/bin/env node
// roonscape typeset pipeline: draft markdown in, published essay page out.
//
//   node tools/typeset.mjs <slug>          typeset drafts/<slug>.md -> essays/<slug>/index.html
//   node tools/typeset.mjs <slug> --push   ...and commit + push (deploys via GitHub Pages)
//
// The model typesets and art-directs; it NEVER writes or rewrites the author's
// prose. A verbatim check enforces this after every run. `{{viz: ...}}` markers
// in the draft become bespoke interactive instruments.
//
// Draft format (drafts/<slug>.md):
//   ---
//   title: Essay Title
//   dek: optional subtitle
//   date: July 2026
//   status: draft | live        (draft renders a DRAFT marker)
//   ---
//   Prose paragraphs...
//   {{viz: description of an interactive the essay needs at this spot}}
//   More prose...

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.join(import.meta.dirname, "..");

// ---- args ----
const slug = process.argv[2];
const push = process.argv.includes("--push");
if (!slug || slug.startsWith("--")) {
  console.error("usage: node tools/typeset.mjs <slug> [--push]");
  process.exit(1);
}
const draftPath = path.join(ROOT, "drafts", `${slug}.md`);
if (!fs.existsSync(draftPath)) {
  console.error(`no draft at drafts/${slug}.md`);
  process.exit(1);
}

// ---- API key: env, falling back to soma's .env (never committed here) ----
if (!process.env.ANTHROPIC_API_KEY) {
  const somaEnv = path.join(ROOT, "..", "soma", ".env");
  if (fs.existsSync(somaEnv)) {
    const m = fs.readFileSync(somaEnv, "utf8").match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].trim();
  }
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("no ANTHROPIC_API_KEY in env or ../soma/.env");
  process.exit(1);
}

// ---- parse draft ----
const raw = fs.readFileSync(draftPath, "utf8");
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
const meta = {};
let body = raw;
if (fmMatch) {
  body = raw.slice(fmMatch[0].length);
  for (const line of fmMatch[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
if (!meta.title) {
  console.error("draft needs a title: in frontmatter");
  process.exit(1);
}

// ---- reference material for the model ----
const styleCss = fs.readFileSync(path.join(ROOT, "assets", "style.css"), "utf8");
const referencePage = fs.readFileSync(
  path.join(ROOT, "essays", "machine-ecology", "index.html"),
  "utf8",
);

const SYSTEM = `You are the typesetter, art director, and editor for roonscape.ai — a
personal site with a dark cosmic-observatory aesthetic (deep space blues,
amber accents, editorial serif). You receive an author's essay draft and
produce the finished HTML page.

THE ONE INVIOLABLE RULE — the prose is not yours:
- Every sentence of the author's prose must appear in the output VERBATIM.
  Word-for-word. Do not rewrite, paraphrase, reorder, trim, or "improve" it.
  Do not add prose of your own to the essay body.
- Permitted transformations only: HTML entity conversion (' -> &rsquo; etc.),
  paragraph/section structure, pull-quotes (verbatim excerpts of the prose),
  epigraph styling for quoted verse, section labels (short uppercase h2 labels
  like WRITING / THE INSTRUMENT are chrome, not prose — you may write those).
- Editorial opinions go in the separate editorial_notes field, never the page.

DESIGN SYSTEM:
- Link /assets/style.css (its contents are provided) and follow the reference
  page's structure and class vocabulary: .essay-top (back link, h1, .dek,
  .date), <article> prose sections, .instrument panels, .epigraph, footer.site.
- Page-specific styles go in an inline <style> using the site's CSS variables
  (--bg, --ink, --muted, --faint, --line, --accent, --bg-panel).
- Self-contained vanilla JS/CSS only. No external requests, no libraries.
- Interactives: deterministic (seeded PRNG, never Date.now/Math.random for
  visuals), devicePixelRatio-aware canvases, respect prefers-reduced-motion,
  responsive down to 375px.

{{viz: ...}} MARKERS:
- Each marker describes an interactive instrument the author wants at that
  position. Build it: an .instrument panel with a short chrome title/subtitle,
  controls, and a live visualization that genuinely illustrates the point.
  Make the model behind it honest — simple but not fake.

EDITORIAL NOTES (separate field):
- Act as a sharp editor: structural feedback, weak transitions, missing beats,
  counterarguments the author should address. Critique and outline only —
  never draft replacement prose (the author writes their own words).

OUTPUT: JSON with "html" (the complete page, starting <!DOCTYPE html>) and
"editorial_notes" (markdown).`;

const userMsg = `Typeset this draft into a finished page at /essays/${slug}/.

FRONTMATTER: ${JSON.stringify(meta)}
${meta.status !== "live" ? "Status is draft: include a small DRAFT marker in the .date line." : ""}

DRAFT PROSE (verbatim — see inviolable rule):
<draft>
${body}
</draft>

SITE STYLESHEET (/assets/style.css):
<stylesheet>
${styleCss}
</stylesheet>

REFERENCE PAGE (an existing essay — match its structure and voice of chrome):
<reference>
${referencePage}
</reference>`;

// ---- call the model ----
console.log(`typesetting drafts/${slug}.md → essays/${slug}/ ...`);
const client = new Anthropic();

const stream = client.messages.stream({
  model: "claude-opus-4-8",
  max_tokens: 64000,
  thinking: { type: "adaptive" },
  output_config: {
    effort: "high",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          html: { type: "string", description: "complete HTML page" },
          editorial_notes: { type: "string", description: "markdown editorial critique" },
        },
        required: ["html", "editorial_notes"],
        additionalProperties: false,
      },
    },
  },
  system: SYSTEM,
  messages: [{ role: "user", content: userMsg }],
});

stream.on("text", () => process.stdout.write("."));
const message = await stream.finalMessage();
console.log("");

if (message.stop_reason === "refusal") {
  console.error("model refused; nothing written");
  process.exit(1);
}
if (message.stop_reason === "max_tokens") {
  console.error("output truncated at max_tokens; nothing written");
  process.exit(1);
}

const text = message.content.find((b) => b.type === "text")?.text ?? "";
const { html, editorial_notes } = JSON.parse(text);

// ---- verbatim check: every draft paragraph must survive intact ----
const alnum = (s) =>
  s
    .normalize("NFKD")
    .replace(/&[a-z#0-9]+;/gi, "") // entities vanish on both sides
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
const pageAlnum = alnum(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " "));
const paragraphs = body
  .split(/\n\s*\n/)
  .map((p) => p.trim())
  .filter((p) => p && !p.startsWith("{{") && alnum(p).length > 30);
const missing = paragraphs.filter((p) => !pageAlnum.includes(alnum(p)));
if (missing.length) {
  console.error(`VERBATIM CHECK FAILED — ${missing.length} paragraph(s) altered or dropped:`);
  for (const p of missing) console.error(`  · ${p.slice(0, 90)}...`);
  const failPath = path.join(ROOT, "drafts", `${slug}.rejected.html`);
  fs.writeFileSync(failPath, html);
  console.error(`rejected output saved to drafts/${slug}.rejected.html — nothing published`);
  process.exit(1);
}
console.log(`verbatim check passed (${paragraphs.length} paragraphs intact)`);

// ---- write outputs ----
const outDir = path.join(ROOT, "essays", slug);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.html"), html);
fs.writeFileSync(path.join(ROOT, "drafts", `${slug}.notes.md`), editorial_notes);
console.log(`wrote essays/${slug}/index.html`);
console.log(`editorial notes → drafts/${slug}.notes.md\n`);
console.log(editorial_notes);

// ---- optionally publish ----
if (push) {
  execSync(`git add essays/${slug} && git commit -m "Essay: ${meta.title}" && git push`, {
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log(`\npublished: https://roonscape.ai/essays/${slug}/`);
} else {
  console.log(`\npreview: http://localhost:8803/essays/${slug}/`);
  console.log(`publish: node tools/typeset.mjs ${slug} --push`);
}
