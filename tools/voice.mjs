#!/usr/bin/env node
// Build the voice corpus: the author's best tweets, long-form notes, and
// articles, distilled into voice/corpus.md for the continuation pipeline.
//
//   node tools/voice.mjs
//
// Sources:
//   ~/Downloads/twitter-archive-no-dms/data/tweets.js      (X export)
//   ~/Downloads/twitter-archive-no-dms/data/note-tweet.js  (long-form notes)
//   roonscape.substack.com posts                           (articles)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "voice");
const ARCHIVE = path.join(os.homedir(), "Downloads", "twitter-archive-no-dms", "data");

const TOP_TWEETS = 120;
const MIN_TWEET_LEN = 100;
const ARTICLE_SLUGS = [
  "eclipse",
  "agi-futures",
  "a-singularity-of-woe-an-epic-in-twelve",
  "805",
  "a-song-of-shapes-and-words",
];

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- tweets: top originals by engagement, long enough to carry voice ----
function parseYTD(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw.slice(raw.indexOf("=") + 1));
}

console.log("parsing tweets.js ...");
const tweets = parseYTD(path.join(ARCHIVE, "tweets.js"))
  .map((t) => t.tweet)
  .filter(
    (t) =>
      !t.full_text.startsWith("RT @") &&
      !t.full_text.startsWith("@") &&
      t.full_text.length >= MIN_TWEET_LEN,
  )
  .map((t) => ({
    text: t.full_text.replace(/https:\/\/t\.co\/\w+/g, "").trim(),
    likes: parseInt(t.favorite_count, 10) || 0,
    date: t.created_at,
  }))
  .filter((t) => t.text.length >= MIN_TWEET_LEN)
  .sort((a, b) => b.likes - a.likes)
  .slice(0, TOP_TWEETS);
console.log(`  ${tweets.length} top tweets (min ${MIN_TWEET_LEN} chars, by likes)`);

// ---- long-form notes ----
const notes = parseYTD(path.join(ARCHIVE, "note-tweet.js"))
  .map((n) => n.noteTweet.core.text)
  .filter((t) => t && t.length >= 400);
console.log(`  ${notes.length} long-form notes (>= 400 chars)`);

// ---- articles from substack ----
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&rsquo;|&#8217;/g, "'")
    .replace(/&lsquo;|&#8216;/g, "'")
    .replace(/&rdquo;|&#8221;/g, '"')
    .replace(/&ldquo;|&#8220;/g, '"')
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const articles = [];
for (const slug of ARTICLE_SLUGS) {
  const url = `https://roonscape.substack.com/p/${slug}`;
  process.stdout.write(`fetching ${slug} ... `);
  try {
    const res = await fetch(url);
    const html = await res.text();
    const title = html.match(/property="og:title" content="([^"]*)"/)?.[1] ?? slug;
    const bodyStart = html.indexOf('class="available-content"');
    const bodyEnd = html.indexOf("</article>", bodyStart);
    if (bodyStart < 0) throw new Error("no article body found");
    const text = stripHtml(html.slice(bodyStart, bodyEnd > 0 ? bodyEnd : undefined));
    articles.push({ slug, title, text });
    console.log(`${text.length} chars`);
  } catch (e) {
    console.log(`FAILED (${e.message})`);
  }
}

// ---- write corpus ----
const corpus = { built_from: { tweets: tweets.length, notes: notes.length, articles: articles.length }, tweets, notes, articles };
fs.writeFileSync(path.join(OUT_DIR, "corpus.json"), JSON.stringify(corpus, null, 1));

let md = `# Voice corpus — roon (@tszzl)\n\nReference prose by the author. Everything below is the author's own writing.\n`;
md += `\n## Articles\n`;
for (const a of articles) md += `\n### ${a.title}\n\n${a.text}\n`;
md += `\n## Long-form notes\n`;
for (const n of notes) md += `\n---\n\n${n}\n`;
md += `\n## Tweets (top by engagement)\n`;
for (const t of tweets) md += `\n- ${t.text.replace(/\n/g, " / ")}\n`;

fs.writeFileSync(path.join(OUT_DIR, "corpus.md"), md);
console.log(`\nwrote voice/corpus.json and voice/corpus.md (${(md.length / 1000).toFixed(0)}k chars)`);
