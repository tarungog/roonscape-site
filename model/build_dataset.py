#!/usr/bin/env python3
"""Build completion-training data from the author's full corpus.

Raw text-completion format (no chat template, no instruction wrapper) —
the point is to learn the distribution of the author's prose, not to make
another assistant. Output: model/data/{train,valid}.jsonl with {"text": ...}.

Sources:
  ~/Downloads/twitter-archive-no-dms/data/tweets.js       all original tweets
  ~/Downloads/twitter-archive-no-dms/data/note-tweet.js   long-form notes
  roonscape-site/voice/corpus.json                        articles (already fetched)
"""

import json
import os
import random
import re
from pathlib import Path

HOME = Path.home()
ARCHIVE = HOME / "Downloads" / "twitter-archive-no-dms" / "data"
ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "data"
OUT.mkdir(exist_ok=True)

def parse_ytd(path):
    raw = path.read_text()
    return json.loads(raw[raw.index("=") + 1 :])

# ---- tweets: every original tweet, cleaned ----
tweets = []
for item in parse_ytd(ARCHIVE / "tweets.js"):
    t = item["tweet"]
    text = t["full_text"]
    if text.startswith("RT @") or text.startswith("@"):
        continue
    text = re.sub(r"https://t\.co/\w+", "", text).strip()
    if len(text) < 40:
        continue
    tweets.append(text)
print(f"tweets: {len(tweets)}")

# ---- long-form notes ----
notes = []
for item in parse_ytd(ARCHIVE / "note-tweet.js"):
    text = item["noteTweet"]["core"]["text"].strip()
    if len(text) >= 200:
        notes.append(text)
print(f"notes: {len(notes)}")

# ---- articles ----
articles = []
corpus_json = ROOT / "voice" / "corpus.json"
if corpus_json.exists():
    for a in json.loads(corpus_json.read_text())["articles"]:
        articles.append(a["text"].strip())
print(f"articles: {len(articles)}")

# ---- assemble samples ----
# Tweets are packed 8-12 per sample separated by blank lines: teaches the
# register without training the model that documents are 200 chars long.
# Notes/articles are chunked to ~6000 chars on paragraph boundaries.
random.seed(0x500)
random.shuffle(tweets)

samples = []
i = 0
while i < len(tweets):
    n = random.randint(8, 12)
    samples.append("\n\n".join(tweets[i : i + n]))
    i += n

def chunk(text, target=6000):
    paras = text.split("\n\n")
    buf, out = "", []
    for p in paras:
        if len(buf) + len(p) > target and buf:
            out.append(buf.strip())
            buf = ""
        buf += p + "\n\n"
    if buf.strip():
        out.append(buf.strip())
    return out

for doc in notes + articles:
    samples.extend(chunk(doc))

random.shuffle(samples)
split = max(1, int(len(samples) * 0.02))
valid, train = samples[:split], samples[split:]

with open(OUT / "train.jsonl", "w") as f:
    for s in train:
        f.write(json.dumps({"text": s}) + "\n")
with open(OUT / "valid.jsonl", "w") as f:
    for s in valid:
        f.write(json.dumps({"text": s}) + "\n")

total_chars = sum(len(s) for s in samples)
print(f"samples: {len(train)} train / {len(valid)} valid, ~{total_chars/1e6:.1f}M chars (~{total_chars/4e6:.1f}M tokens)")
