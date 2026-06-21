#!/usr/bin/env node
// Arkstage Phase 2 sync tool — orchestrator / CLI.
//
// Mirrors Arknights story assets from prts.wiki into a static tree:
//   out/index.json              structured 剧情一览 index
//   out/manifests/<title>.json  per-story JSON array of canonical keys
//   out/media/<key>             downloaded asset bytes
//   out/version.json            { ref, generatedAt, counts }
//
// Modes:
//   (default) --spike   fully working: W2G/BEG + two index-derived stories
//   --incremental <ISO> re-sync titles changed since <ISO> (recentchanges API)
//   --backfill          walk all index stories, bounded --limit N, cursor persisted
//
// Throttle: page fetches ≤2 concurrent (wiki.js); media ≤2 concurrent AND <5 MB/s
// (media.js). The spike is intentionally slowish — that's correct/respectful.
//
// Canonical-key contract: manifests store keys produced by canonicalKey() (a JS
// port of src-tauri/src/media.rs canonical_key), so the Rust app and this tool
// agree on the content-addressed store key `{host}/{path}`.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

import {
  fetchPage,
  parseStoryIndex,
  extractWidgetBundle,
  extractStoryScript,
} from "./wiki.js";
import { captureManifest, prewarmEngineDeps } from "./engine.js";
import { downloadKey } from "./media.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Where the mirror tree is written. Defaults to ./out for local spikes; CI points
// SYNC_OUT at the arkstage-assets checkout root so files land at the repo root.
const OUT_DIR = process.env.SYNC_OUT
  ? path.resolve(process.env.SYNC_OUT)
  : path.resolve(__dirname, "out");
// Headless Chrome. CI may install it elsewhere (e.g. google-chrome-stable).
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

// The widget bundle is the same for every story; we fetch it ONCE from W2G/BEG.
const BUNDLE_SOURCE = "W2G/BEG";
const INDEX_PAGE = "剧情一览";

/** Sanitize a page title into a filesystem-safe manifest filename. */
function sanitizeTitle(title) {
  return title.replace(/[/\\:*?"<>|]/g, "_");
}

/** Launch headless Chrome via puppeteer-core. */
function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/**
 * Sync a single story: capture manifest, write manifest file, download its media.
 * @returns {Promise<{ pageTitle: string, keyCount: number, mediaFiles: number, bytes: number, errors: number }>}
 */
async function syncStory(browser, bundle, pageTitle) {
  const html = await fetchPage(pageTitle);
  const sp = extractStoryScript(html);
  if (!sp || !sp.script) {
    throw new Error(`no #datas_txt script on page: ${pageTitle}`);
  }
  // Engine reads #firstHeading.innerText for the page name; prefer the page's own.
  const title = sp.title || pageTitle;

  const keys = await captureManifest(browser, bundle, sp.script, title);
  console.log(`  [${pageTitle}] manifest: ${keys.length} keys`);

  const manifestPath = path.join(OUT_DIR, "manifests", `${sanitizeTitle(pageTitle)}.json`);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(keys, null, 0) + "\n");

  // Download each key's media (throttled globally inside media.js).
  let mediaFiles = 0;
  let bytes = 0;
  let errors = 0;
  const results = await Promise.all(keys.map((k) => downloadKey(k, OUT_DIR)));
  for (const r of results) {
    if (r.ok) {
      mediaFiles++;
      bytes += r.bytes;
    } else {
      errors++;
      console.warn(`    ! download failed: ${r.key} (${r.error})`);
    }
  }
  console.log(
    `  [${pageTitle}] media: ${mediaFiles}/${keys.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB` +
      (errors ? `, ${errors} errors` : "")
  );
  return { pageTitle, keyCount: keys.length, mediaFiles, bytes, errors };
}

/** Fetch + parse the index once, write out/index.json, return the structure. */
async function buildIndex() {
  console.log(`Fetching index page "${INDEX_PAGE}"…`);
  const html = await fetchPage(INDEX_PAGE);
  const index = parseStoryIndex(html);
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2) + "\n");
  const storyCount = index.categories.reduce(
    (n, c) => n + c.chapters.reduce((m, ch) => m + ch.stories.length, 0),
    0
  );
  console.log(
    `Index: ${index.categories.length} categories, ${storyCount} stories -> out/index.json`
  );
  return index;
}

/** Flatten all story pageTitles from the index, in order. */
function allStoryTitles(index) {
  const titles = [];
  for (const cat of index.categories)
    for (const ch of cat.chapters) for (const s of ch.stories) titles.push(s.page_title);
  return titles;
}

/** Pick the spike's 3 stories: W2G/BEG + two distinct real scenarios from the index. */
function pickSpikeTitles(index) {
  const picks = [BUNDLE_SOURCE];
  const all = allStoryTitles(index);
  // Prefer real scenario leaves (…/BEG, …/END, …/ENTRY) over the near-empty
  // "特殊" container pages (隐藏剧情/剧情, 采购中心/剧情) that hold almost no assets.
  const scenarioLike = (t) => /\/(BEG|END|ENTRY|\d)/i.test(t);
  for (const t of all) {
    if (picks.length >= 3) break;
    if (picks.includes(t) || !scenarioLike(t)) continue;
    picks.push(t);
  }
  // Fallback: if somehow under-filled, top up with anything.
  for (const t of all) {
    if (picks.length >= 3) break;
    if (!picks.includes(t)) picks.push(t);
  }
  return picks;
}

/** Write out/version.json. */
async function writeVersion(ref, counts) {
  const version = {
    ref,
    generatedAt: process.env.SYNC_NOW || new Date().toISOString(),
    counts,
  };
  await fs.writeFile(path.join(OUT_DIR, "version.json"), JSON.stringify(version, null, 2) + "\n");
  console.log(`version.json: ${JSON.stringify(version)}`);
}

/**
 * Count the cumulative mirror actually on disk — the truthful figure for the
 * incremental/backfill modes (which append to an existing tree across runs).
 * `manifests` == synced stories (one manifest per story); `mediaFiles` is the
 * deduped on-disk asset count.
 */
async function countMirror() {
  const countFiles = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let n = 0;
    for (const e of entries) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? await countFiles(p) : 1;
    }
    return n;
  };
  const manifests = await countFiles(path.join(OUT_DIR, "manifests"));
  const mediaFiles = await countFiles(path.join(OUT_DIR, "media"));
  return { stories: manifests, mediaFiles, manifests };
}

/** Ref written into version.json (CI pins this to the commit SHA via SYNC_REF). */
const REF = () => process.env.SYNC_REF || "main";

/** Drive a list of story pageTitles through the full pipeline. */
async function runStories(titles, ref) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log("Prewarming engine deps (jquery/preloadjs/toolbox)…");
  await prewarmEngineDeps();

  console.log(`Fetching widget bundle from "${BUNDLE_SOURCE}" (reused for all stories)…`);
  const bundleHtml = await fetchPage(BUNDLE_SOURCE);
  const bundle = extractWidgetBundle(bundleHtml);
  if (bundle.engine_scripts.length === 0) {
    throw new Error("widget bundle has no engine scripts — cannot boot engine");
  }
  console.log(`  bundle: ${bundle.engine_scripts.length} engine script blocks`);

  const browser = await launchBrowser();
  let totalKeys = 0;
  let totalMedia = 0;
  let totalBytes = 0;
  const perStory = [];
  try {
    for (const title of titles) {
      console.log(`\nStory: ${title}`);
      try {
        const r = await syncStory(browser, bundle, title);
        perStory.push(r);
        totalKeys += r.keyCount;
        totalMedia += r.mediaFiles;
        totalBytes += r.bytes;
      } catch (e) {
        console.error(`  ! ${title}: ${e.message}`);
        perStory.push({ pageTitle: title, keyCount: 0, mediaFiles: 0, bytes: 0, errors: 1 });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { perStory, totalKeys, totalMedia, totalBytes };
}

// ─── Modes ──────────────────────────────────────────────────────────────────

async function runSpike() {
  const index = await buildIndex();
  const titles = pickSpikeTitles(index);
  console.log(`\nSpike stories: ${titles.join(", ")}`);

  const { perStory, totalMedia, totalBytes } = await runStories(titles, REF());

  await writeVersion(REF(), await countMirror());

  console.log("\n=== SPIKE SUMMARY ===");
  for (const s of perStory) {
    console.log(
      `  ${s.pageTitle}: ${s.keyCount} keys, ${s.mediaFiles} files, ${(s.bytes / 1024 / 1024).toFixed(2)} MB`
    );
  }
  console.log(`  TOTAL media files: ${totalMedia}, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Output left in: ${OUT_DIR}`);
}

// Incremental: query recentchanges since <ISO>, intersect with index story titles,
// and re-sync only the changed subset (idempotent — cached assets are skipped).
async function runIncremental(sinceISO) {
  if (!sinceISO) throw new Error("--incremental requires an ISO timestamp arg");
  console.log(`[incremental] since ${sinceISO}`);
  const api =
    "https://prts.wiki/api.php?action=query&list=recentchanges" +
    "&rcnamespace=0&rclimit=500&format=json" +
    `&rcend=${encodeURIComponent(sinceISO)}`;
  const resp = await fetch(api, {
    headers: { "User-Agent": "ArkstageSync/0.1", Referer: "https://prts.wiki/" },
  });
  if (!resp.ok) throw new Error(`recentchanges HTTP ${resp.status}`);
  const json = await resp.json();
  const changedTitles = new Set(
    (json?.query?.recentchanges || []).map((rc) => rc.title).filter(Boolean)
  );

  const index = await buildIndex();
  const indexTitles = new Set(allStoryTitles(index));
  // recentchanges titles use display form with spaces; index pageTitles use the
  // underscore/url-decoded form. Match loosely on both.
  const toSync = [...indexTitles].filter(
    (t) => changedTitles.has(t) || changedTitles.has(t.replace(/_/g, " "))
  );

  console.log(`[incremental] ${changedTitles.size} ns0 changes; ${toSync.length} known story pages affected`);
  if (toSync.length === 0) {
    console.log("[incremental] nothing to re-sync.");
    return;
  }
  console.log(`[incremental] re-syncing ${toSync.length} stories…`);
  await runStories(toSync, REF());
  await writeVersion(REF(), await countMirror());
}

// Backfill: walk ALL index stories in order, bounded by --limit N per run,
// persisting a cursor (out/.cursor.json) so successive runs resume where they left
// off. Designed for the manual-dispatch Action that fills the mirror in batches.
async function runBackfill(limit) {
  const n = Number(limit) || 25;
  const index = await buildIndex();
  const all = allStoryTitles(index);

  const cursorPath = path.join(OUT_DIR, ".cursor.json");
  let cursor = 0;
  try {
    cursor = JSON.parse(await fs.readFile(cursorPath, "utf8")).next || 0;
  } catch {
    // fresh start
  }

  const slice = all.slice(cursor, cursor + n);
  console.log(`[backfill] total ${all.length} stories; cursor=${cursor}; this run limit=${n} (${slice.length} stories)`);
  if (slice.length === 0) {
    console.log("[backfill] cursor at end — nothing left.");
    return;
  }

  const { totalMedia, totalBytes } = await runStories(slice, REF());
  console.log(
    `[backfill] synced ${slice.length} stories this run: ${totalMedia} media files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`
  );
  await writeVersion(REF(), await countMirror());

  // Advance the cursor only after a successful run so a crash mid-batch resumes
  // (re-syncing a story is idempotent — cached files are skipped).
  const next = cursor + slice.length;
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(cursorPath, JSON.stringify({ next, total: all.length }) + "\n");
  console.log(`[backfill] cursor advanced to ${next}/${all.length} -> ${cursorPath}`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.includes("--incremental")) {
    await runIncremental(flag("--incremental"));
  } else if (argv.includes("--backfill")) {
    await runBackfill(flag("--limit"));
  } else if (argv.includes("--spike") || argv.length === 0) {
    await runSpike();
  } else {
    // Explicit story titles: sync exactly those (still builds index + version).
    const titles = argv.filter((a) => !a.startsWith("--"));
    await buildIndex();
    await runStories(titles, REF());
    await writeVersion(REF(), await countMirror());
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
