#!/usr/bin/env node
// The roonscape editor — a natively machine-augmented text editor.
//
//   node editor/server.mjs        (port 8805)
//
// Serves the editor UI and the machine endpoints behind it:
//   GET  /api/drafts               list drafts
//   GET  /api/drafts/:slug         read one
//   PUT  /api/drafts/:slug         save
//   POST /api/continue             {slug, before, after, hint} -> job
//   POST /api/typeset              {slug} -> job (spawns tools/typeset.mjs)
//   POST /api/publish              {slug} -> job (git add/commit/push)
//   GET  /api/jobs/:id             {status, log, result}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, sampleCandidates, judgeCandidates, critiqueDraft, ideate } from "../tools/lib.mjs";

const PORT = 8805;
const DRAFTS = path.join(ROOT, "drafts");
fs.mkdirSync(DRAFTS, { recursive: true });

// ---- job store ----
const jobs = new Map();
let jobSeq = 0;
function newJob(kind) {
  const id = `j${++jobSeq}`;
  const job = { id, kind, status: "running", log: [], result: null, error: null };
  jobs.set(id, job);
  return job;
}
const logTo = (job) => (line) => job.log.push(line);

// ---- job runners ----
async function runContinue(job, { before, after, hint }) {
  job.log.push("sampling candidates (fable x2, sol x2) ...");
  const candidates = await sampleCandidates({ before, after, hint, onProgress: logTo(job) });
  if (candidates.length < 2) throw new Error("fewer than 2 candidates; not enough to judge");
  const verdict = await judgeCandidates({ before, candidates, onProgress: logTo(job) });
  job.result = { candidates, verdict };
}

async function runCritique(job, { draft }) {
  const { synthesis } = await critiqueDraft({ draft, onProgress: logTo(job) });
  job.result = { report: synthesis };
}

async function runIdeate(job, { context, question }) {
  const { selection } = await ideate({ context, question, onProgress: logTo(job) });
  job.result = { report: selection };
}

function runProcess(job, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...opts });
    const onData = (d) =>
      String(d)
        .split("\n")
        .filter((l) => l.trim() && !/^\.+$/.test(l.trim()))
        .forEach((l) => job.log.push(l));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function runTypeset(job, { slug }) {
  await runProcess(job, "node", ["tools/typeset.mjs", slug]);
  const notesPath = path.join(DRAFTS, `${slug}.notes.md`);
  job.result = {
    preview: `http://localhost:8803/essays/${slug}/`,
    notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : "",
  };
}

async function runPublish(job, { slug }) {
  await runProcess(job, "git", ["add", `essays/${slug}`]);
  await runProcess(job, "git", ["commit", "-m", `Essay: ${slug}`]).catch((e) => {
    if (!job.log.some((l) => l.includes("nothing to commit"))) throw e;
  });
  await runProcess(job, "git", ["push"]);
  job.result = { live: `https://roonscape.ai/essays/${slug}/` };
}

function launch(kind, runner, params) {
  const job = newJob(kind);
  runner(job, params)
    .then(() => (job.status = "done"))
    .catch((e) => {
      job.status = "error";
      job.error = e.message;
      job.log.push(`ERROR: ${e.message}`);
    });
  return job;
}

// ---- http plumbing ----
const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => resolve(b ? JSON.parse(b) : {}));
  });
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const safeSlug = (s) => /^[a-z0-9-]+$/i.test(s);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(fs.readFileSync(path.join(import.meta.dirname, "index.html")));
    }

    if (parts[0] === "api" && parts[1] === "drafts") {
      if (!parts[2]) {
        const list = fs
          .readdirSync(DRAFTS)
          .filter((f) => f.endsWith(".md") && !f.includes(".notes.") && !f.includes(".continuations."))
          .map((f) => {
            const slug = f.replace(/\.md$/, "");
            const stat = fs.statSync(path.join(DRAFTS, f));
            return { slug, mtime: stat.mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
        return json(res, 200, list);
      }
      const slug = parts[2];
      if (!safeSlug(slug)) return json(res, 400, { error: "bad slug" });
      const file = path.join(DRAFTS, `${slug}.md`);
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
        return json(res, 200, { slug, text: fs.readFileSync(file, "utf8") });
      }
      if (req.method === "PUT") {
        const { text } = await readBody(req);
        fs.writeFileSync(file, text);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "continue") {
      const { before, after, hint } = await readBody(req);
      return json(res, 200, { jobId: launch("continue", runContinue, { before, after, hint }).id });
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "critique") {
      const { draft } = await readBody(req);
      return json(res, 200, { jobId: launch("critique", runCritique, { draft }).id });
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "ideate") {
      const { context, question } = await readBody(req);
      return json(res, 200, { jobId: launch("ideate", runIdeate, { context, question }).id });
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "typeset") {
      const { slug } = await readBody(req);
      if (!safeSlug(slug)) return json(res, 400, { error: "bad slug" });
      return json(res, 200, { jobId: launch("typeset", runTypeset, { slug }).id });
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "publish") {
      const { slug } = await readBody(req);
      if (!safeSlug(slug)) return json(res, 400, { error: "bad slug" });
      return json(res, 200, { jobId: launch("publish", runPublish, { slug }).id });
    }
    if (parts[0] === "api" && parts[1] === "jobs" && parts[2]) {
      const job = jobs.get(parts[2]);
      if (!job) return json(res, 404, { error: "no such job" });
      return json(res, 200, job);
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`roonscape editor on http://localhost:${PORT}`));
