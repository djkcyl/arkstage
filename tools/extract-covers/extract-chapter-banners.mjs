#!/usr/bin/env node
// Build the chapter-detail TOP BANNERS: each non-特殊 book's 活动预告图 (the wide
// event splash from prts 活动一览, the 标题图文件名 property). Shown behind the
// ChapterDetail hero with a bottom fade. 集成战略/生息演算 are 特殊 (no 活动预告)
// so they reuse their own cover banner instead (copied from assets/covers).
//
// Map: chapter-banner-map.json  ({ bookKey: "<prts File name>" }) — generated from
// storylines.json × the 活动一览 SMW 标题图文件名 property.
// Output: frontend/src/assets/banners/<sanitize(bookKey)>.webp (<=560px wide).
//
//   node tools/extract-covers/extract-chapter-banners.mjs
//
// Requires ImageMagick + Node 18+. (7 early main-story EPs predate event splashes
// and have no 活动预告 — they keep the gradient hero.)

import { promises as fs, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAP_FILE = path.join(__dirname, "chapter-banner-map.json");
const OUT_DIR = path.join(REPO_ROOT, "frontend", "src", "assets", "banners");
const COVERS_DIR = path.join(REPO_ROOT, "frontend", "src", "assets", "covers");
const TMP_DIR = path.join(os.tmpdir(), "chapter-banners");
const MAX_WIDTH = 560;
const API = "https://prts.wiki/api.php";
// 特殊 modes whose chapter banner = their own cover (per request).
const COVER_AS_BANNER = ["集成战略", "生息演算"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sanitize = (s) => s.replace(/[/\\:*?"<>|]/g, "_");

async function fileUrl(name) {
  const u = `${API}?action=query&format=json&prop=imageinfo&iiprop=url&titles=${encodeURIComponent("File:" + name)}`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
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
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
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

  let ok = 0;
  const missing = [];
  for (const [book, file] of Object.entries(map)) {
    const url = await fileUrl(file);
    const src = path.join(TMP_DIR, sanitize(file));
    if (!url || !(await download(url, src))) {
      missing.push(book);
      continue;
    }
    const dest = path.join(OUT_DIR, `${sanitize(book)}.webp`);
    execFileSync("convert", [src, "-resize", `${MAX_WIDTH}x>`, "-quality", "78", dest]);
    ok++;
  }

  // 集成战略/生息演算: chapter banner = their cover banner.
  for (const book of COVER_AS_BANNER) {
    const cov = path.join(COVERS_DIR, `${sanitize(book)}.webp`);
    if (existsSync(cov)) {
      await fs.copyFile(cov, path.join(OUT_DIR, `${sanitize(book)}.webp`));
      ok++;
    } else missing.push(`${book} (cover missing)`);
  }

  const total = (await fs.readdir(OUT_DIR)).filter((f) => f.endsWith(".webp")).length;
  console.log(`Chapter banners: ${ok} written; ${total} total in ${path.relative(REPO_ROOT, OUT_DIR)}.`);
  if (missing.length) {
    console.error(`MISSING (${missing.length}): ${missing.join(", ")}`);
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
