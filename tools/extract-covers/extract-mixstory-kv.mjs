#!/usr/bin/env node
// Build the app's bookshelf covers from the in-game StoryLine ("mixstory") key
// visuals — the exact 曲谱/乐章 album cards the game shows in the StoryLine view:
//   - square 432x432 for main-story EPs   (e.g. 反常光谱, 相变临界)
//   - wide   ~632x456 for activities       (e.g. 银心湖列车, 风雪过境)
//
// Source: ArknightsAssets/ArknightsAssets2@cn
//   assets/dyn/arts/ui/mixstory/kvs/kv_<englishName>.png
//
// The kv filenames are English story names; the curated map kv-map.json pairs
// each to the exact book key our index uses (activity_name || name). That map
// was built by joining CN+EN story_review_table and, for the newest CN-only EPs
// and a few naming quirks, reading the title baked into the kv / its title logo
// (see memory playbook). `ato`(命途) has no matching book and is intentionally
// absent; ~12 special game modes (集成战略/生息演算/泰拉饭/…) have no StoryLine
// kv and keep the procedural gradient fallback.
//
// Output:
//   - frontend/src/assets/covers/<sanitize(bookKey)>.webp   (<=420px wide, q80)
//   - frontend/src/data/cover-dims.json                     ({ "<key>": [w,h] })
//
// Requires ImageMagick (`convert`, `identify`) and Node 18+. Run from anywhere:
//   node tools/extract-covers/extract-mixstory-kv.mjs
// Offline fallback: set KV_LOCAL_CLONE to a local ArknightsAssets2 git clone
// (cn branch) and blobs are read via `git cat-file` instead of the network.

import { promises as fs, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAP_FILE = path.join(__dirname, "kv-map.json");
const OUT_DIR = path.join(REPO_ROOT, "frontend", "src", "assets", "covers");
const DIMS_FILE = path.join(REPO_ROOT, "frontend", "src", "data", "cover-dims.json");
const TMP_DIR = path.join(os.tmpdir(), "mixstory-kv");

const ASSET_REPO = "ArknightsAssets/ArknightsAssets2";
const ASSET_REF = "cn";
const KV_DIR = "assets/dyn/arts/ui/mixstory/kvs";
const LOCAL_CLONE = process.env.KV_LOCAL_CLONE || null;
const MAX_WIDTH = 420;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mirror sanitizeCoverKey() in frontend/src/lib/cover.ts (filesystem-safe key).
const sanitize = (s) => s.replace(/[/\\:*?"<>|]/g, "_");

/** Fetch a kv PNG: local git clone first (offline), then jsDelivr/raw. */
async function fetchKv(name) {
  const rel = `${KV_DIR}/kv_${name}.png`;
  if (LOCAL_CLONE) {
    try {
      const sha = execFileSync("git", ["-C", LOCAL_CLONE, "rev-parse", `origin/${ASSET_REF}:${rel}`], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      const buf = execFileSync("git", ["-C", LOCAL_CLONE, "cat-file", "-p", sha], { maxBuffer: 64 << 20 });
      if (buf.length) return buf;
    } catch {
      /* fall through to network */
    }
  }
  const urls = [
    `https://cdn.jsdelivr.net/gh/${ASSET_REPO}@${ASSET_REF}/${rel}`,
    `https://raw.githubusercontent.com/${ASSET_REPO}/${ASSET_REF}/${rel}`,
  ];
  for (let i = 0; i < 6; i++) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
        if (r.ok) {
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length) return b;
        }
      } catch {
        /* next */
      }
    }
    await sleep(3000);
  }
  return null;
}

async function main() {
  const map = JSON.parse(readFileSync(MAP_FILE, "utf8"));
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });

  const dims = {};
  let ok = 0;
  const missing = [];
  for (const [kv, book] of Object.entries(map)) {
    const buf = await fetchKv(kv);
    if (!buf) {
      missing.push(kv);
      continue;
    }
    const key = sanitize(book);
    const png = path.join(TMP_DIR, `${kv}.png`);
    const dest = path.join(OUT_DIR, `${key}.webp`);
    await fs.writeFile(png, buf);
    // shrink-only so we never upscale the small native art
    execFileSync("convert", [png, "-resize", `${MAX_WIDTH}x>`, "-quality", "80", dest]);
    const [w, h] = execFileSync("identify", ["-format", "%w %h", dest]).toString().trim().split(" ").map(Number);
    dims[key] = [w, h];
    ok++;
  }

  const sorted = Object.fromEntries(Object.keys(dims).sort().map((k) => [k, dims[k]]));
  await fs.writeFile(DIMS_FILE, JSON.stringify(sorted) + "\n");

  const total = (await fs.readdir(OUT_DIR))
    .filter((f) => f.endsWith(".webp"))
    .reduce((n, f) => n + readFileSync(path.join(OUT_DIR, f)).length, 0);
  console.log(`Bundled ${ok}/${Object.keys(map).length} covers → ${path.relative(REPO_ROOT, OUT_DIR)} (${(total / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Wrote ${path.relative(REPO_ROOT, DIMS_FILE)} (${Object.keys(sorted).length} entries)`);
  if (missing.length) {
    console.error(`\nMISSING ${missing.length} kvs (no source): ${missing.join(", ")}`);
    process.exitCode = 2;
  }
}

if (!existsSync(MAP_FILE)) {
  console.error(`missing ${MAP_FILE}`);
  process.exit(1);
}
main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
