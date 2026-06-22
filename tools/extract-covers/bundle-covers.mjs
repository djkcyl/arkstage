#!/usr/bin/env node
// Turn the extracted 剧情一览 covers (out-storyentry/*.png, transparent cutouts)
// into small bundled assets for the app:
//   - frontend/src/assets/covers/<name>.webp   (resized ~300px wide, alpha kept)
//   - frontend/src/data/cover-dims.json        ({ "<coverKey>": [w, h] })
// <name> is sanitize(coverKey) — the same key the bookshelf uses (activity_name).
// Requires ImageMagick `convert`. Run after extract-storyentry.mjs.
//
//   node tools/extract-covers/bundle-covers.mjs

import { promises as fs, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(__dirname, "out-storyentry");
const OUT_DIR = path.join(REPO_ROOT, "frontend", "src", "assets", "covers");
const DIMS_FILE = path.join(REPO_ROOT, "frontend", "src", "data", "cover-dims.json");
const WIDTH = 300;

/** PNG intrinsic size from the IHDR header (bytes 16..24), no image lib needed. */
function pngSize(file) {
  const b = readFileSync(file).subarray(16, 24);
  return [b.readUInt32BE(0), b.readUInt32BE(4)];
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const files = (await fs.readdir(SRC_DIR)).filter((f) => f.endsWith(".png"));
  const dims = {};
  let ok = 0;
  for (const f of files) {
    const key = f.replace(/\.png$/, ""); // already sanitize(coverKey)
    const src = path.join(SRC_DIR, f);
    const dest = path.join(OUT_DIR, `${key}.webp`);
    const [w, h] = pngSize(src);
    dims[key] = [w, h];
    execFileSync("convert", [src, "-resize", `${WIDTH}x`, "-quality", "80", dest]);
    ok++;
  }
  // stable key order for a clean diff
  const sorted = Object.fromEntries(Object.keys(dims).sort().map((k) => [k, dims[k]]));
  await fs.writeFile(DIMS_FILE, JSON.stringify(sorted) + "\n");
  const total = (await fs.readdir(OUT_DIR))
    .filter((f) => f.endsWith(".webp"))
    .reduce((n, f) => n + readFileSync(path.join(OUT_DIR, f)).length, 0);
  console.log(`Bundled ${ok} covers → ${path.relative(REPO_ROOT, OUT_DIR)} (${(total / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Wrote ${path.relative(REPO_ROOT, DIMS_FILE)} (${Object.keys(sorted).length} entries)`);
}

if (!existsSync(SRC_DIR)) {
  console.error(`missing ${SRC_DIR} — run extract-storyentry.mjs first`);
  process.exit(1);
}
main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
