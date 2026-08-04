#!/usr/bin/env node
// Build covers for books that have no in-game StoryLine (mixstory) kv but do have
// a prts banner: 联动 (collab) events use 活动一览's 活动导引图 (`活动预告 … 01.jpg`),
// and the 集成战略 / 生息演算 game modes use their latest-season 头图/活动预告 banner.
// All have the title baked in, so CoverCard suppresses the text overlay for them
// (aspect ≥ 2). Books with neither kv nor banner (特殊/四月辑录) get the app-logo
// placeholder.
//
// Source: prts.wiki File:<name> (resolved via the imageinfo API → media URL).
// Map: activity-banner-covers.json  ({ bookKey: "<prts File name>" }).
// Output: merges into build/resources-source/covers/<sanitize(bookKey)>.webp and
// build/resources-source/cover-dims.json (run AFTER extract-mixstory-kv.mjs).
//
//   node tools/extract-covers/extract-banner-covers.mjs
//
// Requires ImageMagick + Node 18+.

import { promises as fs, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAP_FILE = path.join(__dirname, "activity-banner-covers.json");
const SOURCE_DIR = path.join(REPO_ROOT, "build", "resources-source");
const OUT_DIR = path.join(SOURCE_DIR, "covers");
const DIMS_FILE = path.join(SOURCE_DIR, "cover-dims.json");
const TMP_DIR = path.join(os.tmpdir(), "banner-covers");
const MAX_WIDTH = 480;
const API = "https://prts.wiki/api.php";
const PRTS_HEADERS = {
  "User-Agent": "ArkstageResourceBuilder/1.0 (+https://github.com/djkcyl/arkstage)",
  Referer: "https://prts.wiki/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitize = (s) => s.replace(/[/\\:*?"<>|]/g, "_");

/** Resolve File:<name> → its media URL via the imageinfo API (with retries). */
async function fileUrl(name) {
  const u = `${API}?action=query&format=json&prop=imageinfo&iiprop=url&titles=${encodeURIComponent("File:" + name)}`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(u, { headers: PRTS_HEADERS, signal: AbortSignal.timeout(30_000) });
      if (r.ok) {
        const d = await r.json();
        const pages = d?.query?.pages || {};
        const p = pages[Object.keys(pages)[0]];
        const url = p?.imageinfo?.[0]?.url;
        if (url) return url;
      }
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  return null;
}

async function download(url, dest) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: PRTS_HEADERS, signal: AbortSignal.timeout(60_000) });
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length) {
          await fs.writeFile(dest, b);
          return true;
        }
      }
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  return false;
}

async function main() {
  const map = JSON.parse(readFileSync(MAP_FILE, "utf8"));
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  const dims = existsSync(DIMS_FILE) ? JSON.parse(readFileSync(DIMS_FILE, "utf8")) : {};

  let ok = 0;
  const missing = [];
  for (const [book, file] of Object.entries(map)) {
    const url = await fileUrl(file);
    const src = path.join(TMP_DIR, sanitize(file));
    if (!url || !(await download(url, src))) {
      missing.push(book);
      continue;
    }
    const key = sanitize(book);
    const dest = path.join(OUT_DIR, `${key}.webp`);
    execFileSync("convert", [src, "-resize", `${MAX_WIDTH}x>`, "-quality", "82", dest]);
    const [w, h] = execFileSync("identify", ["-format", "%w %h", dest]).toString().trim().split(" ").map(Number);
    dims[key] = [w, h];
    ok++;
    console.log(`  ↓ ${book} (${w}×${h})`);
  }

  const sorted = Object.fromEntries(Object.keys(dims).sort().map((k) => [k, dims[k]]));
  await fs.writeFile(DIMS_FILE, JSON.stringify(sorted) + "\n");
  console.log(`\nBanner covers: ${ok}/${Object.keys(map).length}; cover-dims.json now ${Object.keys(sorted).length} entries.`);
  if (missing.length) {
    console.error(`MISSING: ${missing.join(", ")}`);
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
