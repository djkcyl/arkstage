#!/usr/bin/env node
// Extract the OFFICIAL 剧情一览 entry covers (storyEntryPic) from ArknightsAssets2.
// These map 1:1 to our story index via each story_review group's storyEntryPicId,
// covering far more activities (old + new) than the home-theme KV. FULL extraction.
//
// Source: assets/dyn/arts/ui/storyreview/hubs/{activity,mini}/storyentrypic_<actId>.png
// Output: ./out-storyentry/<sanitized activity name>.png  (== app book coverKey)
//
//   node tools/extract-covers/extract-storyentry.mjs          # map + download
//   node tools/extract-covers/extract-storyentry.mjs --list   # mapping report only

import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out-storyentry");
const INDEX_FILE = path.join(REPO_ROOT, "frontend", "src", "data", "story-index.json");

const ASSET_REPO = "ArknightsAssets/ArknightsAssets2";
const ASSET_REF = "cn";
const HUB_DIRS = [
  "assets/dyn/arts/ui/storyreview/hubs/activity",
  "assets/dyn/arts/ui/storyreview/hubs/mini/storyentrypic",
];
const GAMEDATA_REPO = "Kengxxiao/ArknightsGameData";
const GAMEDATA_REF = "master";
const SRT_PATH = "zh_CN/gamedata/excel/story_review_table.json";

const LIST_ONLY = process.argv.includes("--list");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitize = (s) => s.replace(/[/\\:*?"<>|]/g, "_");

async function fetchText(repo, ref, p, tries = 30) {
  const urls = [
    `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${p}`,
    `https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
  ];
  for (let i = 0; i < tries; i++) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(40_000) });
        if (r.ok) return await r.text();
      } catch {
        /* next */
      }
    }
    await sleep(4000);
  }
  throw new Error(`fetchText failed: ${p}`);
}

async function fetchBinary(repo, ref, p, tries = 8) {
  const urls = [
    `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${p}`,
    `https://raw.githubusercontent.com/${repo}/${ref}/${p}`,
  ];
  for (let i = 0; i < tries; i++) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
        if (r.ok) {
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length > 0) return b;
        }
      } catch {
        /* next */
      }
    }
    await sleep(4000);
  }
  return null;
}

function indexNames() {
  const idx = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
  const s = new Set();
  for (const c of idx.categories) for (const ch of c.chapters) s.add(ch.activity_name || ch.name);
  return s;
}

async function main() {
  console.log("Loading story_review_table…");
  const srt = JSON.parse(await fetchText(GAMEDATA_REPO, GAMEDATA_REF, SRT_PATH));
  const groups = srt.storyreviewtable || srt;
  const names = indexNames();

  // name → storyEntryPic filename (lowercased), keeping the first (dedupes reruns).
  const byName = new Map();
  const noPic = [];
  for (const g of Object.values(groups)) {
    if (!g || typeof g !== "object" || !g.name) continue;
    if (!names.has(g.name)) continue;
    const picId = g.storyEntryPicId;
    if (!picId) {
      noPic.push(g.name);
      continue;
    }
    if (!byName.has(g.name)) byName.set(g.name, `${String(picId).toLowerCase()}.png`);
  }

  console.log(`\n=== ${byName.size} activities matched (of ${names.size} in index) ===`);
  for (const [n, f] of byName) console.log(`  ${n}  ←  ${f}`);
  if (noPic.length) console.log(`\n(${noPic.length} matched-name groups have no storyEntryPicId: ${noPic.slice(0, 15).join(", ")}${noPic.length > 15 ? "…" : ""})`);
  if (LIST_ONLY) return;

  await fs.mkdir(OUT_DIR, { recursive: true });
  let ok = 0;
  const missing = [];
  for (const [name, file] of byName) {
    const dest = path.join(OUT_DIR, `${sanitize(name)}.png`);
    if (await fs.stat(dest).then((s) => s.size > 0).catch(() => false)) {
      ok++;
      continue;
    }
    let buf = null;
    for (const dir of HUB_DIRS) {
      buf = await fetchBinary(ASSET_REPO, ASSET_REF, `${dir}/${file}`);
      if (buf) break;
    }
    if (!buf) {
      missing.push(name);
      continue;
    }
    await fs.writeFile(dest, buf);
    ok++;
    console.log(`  ↓ ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  console.log(`\nDone: ${ok}/${byName.size} covers in ${OUT_DIR}`);
  if (missing.length) {
    console.log(`Not found in hubs (${missing.length}): ${missing.slice(0, 20).join(", ")}`);
    process.exitCode = 2; // let the grind retry the missing ones
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
