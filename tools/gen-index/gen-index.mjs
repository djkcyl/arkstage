#!/usr/bin/env node
// Regenerate the app's bundled story index (frontend/src/data/story-index.json)
// by fetching + parsing prts.wiki's 剧情一览 page. FULL update only (no delta).
//
// One cross-platform script for BOTH local use and CI:
//   node tools/gen-index/gen-index.mjs          (run from anywhere; paths are absolute)
//
// The parse is a port of src-tauri/src/parser/story_index.rs (the same logic the
// app uses to refresh the index at runtime), so the bundled baseline matches a
// runtime refresh. Requires Node 18+ (global fetch) and cheerio.

import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_FILE = path.join(REPO_ROOT, "frontend", "src", "data", "story-index.json");
const INDEX_PAGE = "剧情一览";
const MIN_STORIES = 1000; // sanity floor: refuse to write a clearly-broken parse

// ---------------------------------------------------------------------------
// StoryLine taxonomy — the in-game "主题曲/Movements" grouping, by narrative arc
// rather than the old 主线/活动 split (membership follows prts 关卡一览/曲谱/回想;
// the 14 headers are the official CN names). The single source of truth is
// frontend/src/data/storylines.json, also consumed by the frontend at runtime so
// the prts-refreshed index gets grouped the same way. Each entry lists the prts
// `activity_name`s (the "book" key) belonging to that StoryLine, in display order;
// anything unlisted (special collections, game modes, CN-only events without
// recollection data) falls through to 特殊.
const STORYLINES = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "frontend", "src", "data", "storylines.json"), "utf8")
);
const SPECIAL_CATEGORY = "特殊";

/**
 * Re-bucket the prts-parsed categories (主线剧情一览 / 活动剧情一览) into the
 * StoryLine taxonomy above. Chapters are matched by their book key
 * (`activity_name`, falling back to `name`); unmatched chapters collect into 特殊.
 */
function regroupByStoryLine(parsed) {
  const used = new Set();
  const categories = [];
  for (const [line, acts] of STORYLINES) {
    const chapters = [];
    for (const act of acts) {
      for (const cat of parsed.categories) {
        for (const ch of cat.chapters) {
          if ((ch.activity_name || ch.name) === act) {
            chapters.push(ch);
            used.add(ch);
          }
        }
      }
    }
    if (chapters.length) categories.push({ name: line, chapters });
  }
  const special = parsed.categories.flatMap((c) => c.chapters).filter((ch) => !used.has(ch));
  if (special.length) categories.push({ name: SPECIAL_CATEGORY, chapters: special });

  const unplaced = [...new Set(special.map((ch) => ch.activity_name || ch.name))];
  console.log(`  StoryLines: ${categories.length - (special.length ? 1 : 0)} + 特殊 (${special.length} chapters)`);
  console.log(`  特殊 activities: ${unplaced.join(", ")}`);
  return { categories };
}

const USER_AGENT = "ArkstageIndexGen/1.0 (+https://github.com/djkcyl/arkstage)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a prts.wiki page's raw HTML (url = /w/<urlencoded title>), with retries. */
async function fetchPage(title) {
  const url = `https://prts.wiki/w/${encodeURIComponent(title)}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Referer: "https://prts.wiki/" },
        signal: AbortSignal.timeout(45_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return await resp.text();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw new Error(`fetchPage(${title}) failed: ${lastErr?.message || lastErr}`);
}

/**
 * Port of `parse_story_index` (story_index.rs): walk every `table.wikitable`,
 * the first <th> is the category, each data row's last <td> holds the story
 * links; rowspan groups become `activity_name`. Emits snake_case keys to match
 * the app's StoryIndex contract.
 */
function parseStoryIndex(html) {
  const $ = cheerio.load(html);
  const categories = [];

  $("table.wikitable").each((_, table) => {
    const $table = $(table);
    const rows = $table.find("tr").toArray();
    if (rows.length === 0) return;

    const firstTh = $(rows[0]).find("th").first();
    const categoryName = firstTh.length ? firstTh.text().trim() : "";
    if (!categoryName) return;

    const chapters = [];
    let currentGroup = "";

    for (let i = 1; i < rows.length; i++) {
      const $row = $(rows[i]);
      const ths = $row.find("th").toArray();
      const tds = $row.find("td").toArray();
      if (tds.length === 0) continue;

      let activityName = null;
      let chapterName;

      if (ths.length === 0) {
        activityName = null;
        chapterName = "未分类";
      } else if (ths.length === 1) {
        const text = $(ths[0]).text().trim();
        const act = currentGroup ? currentGroup : null;
        if (!text) {
          activityName = null;
          chapterName = currentGroup;
        } else {
          activityName = act;
          chapterName = text;
        }
      } else {
        const first = $(ths[0]).text().trim();
        const last = $(ths[ths.length - 1]).text().trim();
        if ($(ths[0]).attr("rowspan") !== undefined) {
          currentGroup = first;
        } else {
          currentGroup = "";
        }
        activityName = first ? first : null;
        chapterName = last ? last : currentGroup;
      }

      if (activityName !== null && activityName === chapterName) activityName = null;

      const $td = $(tds[tds.length - 1]);
      const stories = [];
      $td.find("a[href]").each((_, a) => {
        const href = $(a).attr("href") || "";
        const displayText = $(a).text().trim();
        if (!displayText || !href.startsWith("/w/")) return;
        let pageTitle = href.slice("/w/".length);
        try {
          pageTitle = decodeURIComponent(pageTitle);
        } catch {
          // keep raw on malformed escapes
        }
        stories.push({ title: displayText, page_title: pageTitle });
      });

      if (stories.length > 0) {
        chapters.push({ name: chapterName, activity_name: activityName, stories });
      }
    }

    if (chapters.length > 0) categories.push({ name: categoryName, chapters });
  });

  return { categories };
}

async function main() {
  console.log(`Fetching "${INDEX_PAGE}" from prts.wiki…`);
  const html = await fetchPage(INDEX_PAGE);
  const parsed = parseStoryIndex(html);
  const index = regroupByStoryLine(parsed);

  const storyCount = index.categories.reduce(
    (n, c) => n + c.chapters.reduce((m, ch) => m + ch.stories.length, 0),
    0
  );
  console.log(`Parsed ${index.categories.length} categories, ${storyCount} stories.`);

  if (index.categories.length === 0 || storyCount < MIN_STORIES) {
    throw new Error(
      `refusing to write: parse looks broken (${storyCount} stories < ${MIN_STORIES}). ` +
        `prts HTML layout may have changed — update parseStoryIndex.`
    );
  }

  // Match the existing file's formatting (2-space indent + trailing newline) so
  // git diffs stay minimal when nothing changed.
  const json = JSON.stringify(index, null, 2) + "\n";
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  let prev = null;
  try {
    prev = await fs.readFile(OUT_FILE, "utf8");
  } catch {
    /* first run */
  }
  if (prev === json) {
    console.log(`No change — ${path.relative(REPO_ROOT, OUT_FILE)} already up to date.`);
    return;
  }
  await fs.writeFile(OUT_FILE, json);
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_FILE)} (${json.length} bytes).`);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
