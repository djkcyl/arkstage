#!/usr/bin/env node
// Regenerate frontend/src/data/storylines.json — the in-game StoryLine ("曲谱")
// taxonomy used to regroup the story index into 篇章. Authoritative source is
// prts 关卡一览/曲谱: each `==篇章==` section lists its member books as `{{/乐章}}`
// templates (in display order). This is the COMPLETE in-game grouping — strictly
// more complete than the /回想 subpages, which only list recollection-enabled
// stories and so drop members like 乌萨斯的孩子们 / 红松林 / 午间逸话 into 特殊.
//
// The main story (为了明日 / 主题曲) lists its EPs as a link table rather than
// {{/乐章}} blocks, so its member list is preserved from the existing
// storylines.json. Books in no 曲谱 section (集成战略/生息演算 and 联动 events
// 泰拉饭/源石尘行动/…) fall through to 特殊 at regroup time.
//
//   node tools/gen-index/gen-storylines.mjs            # fetch + rebuild
//   node tools/gen-index/gen-storylines.mjs --report   # also print match report
//
// Requires Node 18+ (global fetch).

import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_FILE = path.join(REPO_ROOT, "frontend", "src", "data", "storylines.json");
const INDEX_PAGE = "剧情一览"; // fetched live (the index is no longer bundled) for book-key matching
const HUB = "关卡一览/曲谱";
const MAIN_LINE = "为了明日"; // main story — kept from existing storylines.json (EP table, not 乐章)
// The 13 side StoryLines, in 曲谱 display order (the main line is prepended).
const SIDE_LINES = [
  "方舟", "燎原", "那被祝福的", "山雪与银铁", "七丘的新芽", "霓虹之下", "岁岁今朝",
  "摘取未来之人", "自海渊的一瞥", "高塔迷影", "薪火重燃", "夏日律动", "泰拉奇谈",
];
const LIANDONG_LINE = "联动"; // collab events — not in the 曲谱 StoryLine system; covers from 活动导引图
// Collab (联动) events, chronological by actId. They have no in-game StoryLine
// (mixstory) entry, so they get a dedicated 联动 category instead of 特殊, with
// covers from 活动一览's 标题图 (see tools/extract-covers/activity-banner-covers.json).
const LIANDONG = ["好久不见", "源石尘行动", "落叶逐火", "水晶箭行动", "泰拉饭", "无忧梦呓", "泡影苍霆"];
const REPORT = process.argv.includes("--report");
const UA = "ArkstageIndexGen/1.0 (+https://github.com/djkcyl/arkstage)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(title, tries = 4) {
  const url = `https://prts.wiki/w/${encodeURIComponent(title)}?action=raw`;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45_000) });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(800 * (i + 1));
  }
  throw new Error(`raw(${title}) failed: ${last?.message || last}`);
}

/** GET a prts.wiki page's rendered HTML (for the 剧情一览 wikitable), with retries. */
async function fetchHtml(title, tries = 4) {
  const url = `https://prts.wiki/w/${encodeURIComponent(title)}`;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://prts.wiki/" }, signal: AbortSignal.timeout(45_000) });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(800 * (i + 1));
  }
  throw new Error(`fetchHtml(${title}) failed: ${last?.message || last}`);
}

/**
 * Port of the 剧情一览 parser (story_index.rs / the old gen-index.mjs): walk every
 * `table.wikitable`, group rows by their rowspan header into `activity_name`. We
 * only need the set of book keys (`activity_name || name`) to match 乐章 names
 * against, so this returns just that set.
 */
function indexBookKeys(html) {
  const $ = cheerio.load(html);
  const keys = new Set();
  $("table.wikitable").each((_, table) => {
    const rows = $(table).find("tr").toArray();
    if (!rows.length) return;
    let currentGroup = "";
    for (let i = 1; i < rows.length; i++) {
      const $row = $(rows[i]);
      const ths = $row.find("th").toArray();
      const tds = $row.find("td").toArray();
      if (tds.length === 0) continue;
      let activityName = null;
      let chapterName;
      if (ths.length === 0) {
        chapterName = "未分类";
      } else if (ths.length === 1) {
        const text = $(ths[0]).text().trim();
        if (!text) chapterName = currentGroup;
        else {
          activityName = currentGroup || null;
          chapterName = text;
        }
      } else {
        const first = $(ths[0]).text().trim();
        const last = $(ths[ths.length - 1]).text().trim();
        currentGroup = $(ths[0]).attr("rowspan") !== undefined ? first : "";
        activityName = first || null;
        chapterName = last || currentGroup;
      }
      if (activityName !== null && activityName === chapterName) activityName = null;
      const hasStories = $(tds[tds.length - 1]).find("a[href^='/w/']").length > 0;
      if (hasStories) keys.add(activityName || chapterName);
    }
  });
  return keys;
}

/** Section name → canonical StoryLine ("主题曲 为了明日" → "为了明日"). */
function sectionLine(header) {
  const s = header.replace(/^主题曲\s*/, "").trim();
  return s === MAIN_LINE || SIDE_LINES.includes(s) ? s : null;
}

/**
 * Bucket every `{{/乐章 |名称=X …}}` book under its enclosing `==篇章==` section.
 * Returns { line -> [book names in document/display order] }.
 */
function parseSections(wikitext) {
  const buckets = {};
  for (const l of [MAIN_LINE, ...SIDE_LINES]) buckets[l] = [];
  const lines = wikitext.split("\n");
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const h = /^==\s*([^=].*?)\s*==$/.exec(t);
    if (h) {
      cur = sectionLine(h[1]);
      continue;
    }
    const m = /^\|名称=(.+)$/.exec(t);
    if (m && cur && /\{\{\/乐章\s*$/.test(lines[i - 1].trim())) buckets[cur].push(m[1].trim());
  }
  return buckets;
}

async function main() {
  console.log(`Fetching index "${INDEX_PAGE}" for book keys…`);
  const bookKeys = indexBookKeys(await fetchHtml(INDEX_PAGE));
  console.log(`  ${bookKeys.size} book keys.`);

  const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
  const mainEntry = prev.find(([n]) => n === MAIN_LINE);
  if (!mainEntry) throw new Error(`existing storylines.json missing "${MAIN_LINE}" entry`);

  console.log(`Fetching hub "${HUB}"…`);
  const buckets = parseSections(await raw(HUB));

  const result = [mainEntry]; // main story preserved
  const unmatched = [];
  for (const line of SIDE_LINES) {
    const keys = [];
    for (const name of buckets[line]) {
      if (bookKeys.has(name)) keys.push(name);
      else {
        const c = [...bookKeys].filter((b) => b === name || b.startsWith(name));
        if (c.length === 1) keys.push(c[0]);
        else unmatched.push(`${line}/${name}${c.length > 1 ? " (ambiguous)" : ""}`);
      }
    }
    result.push([line, keys]);
    console.log(`  ${line}: ${keys.length} books`);
  }

  // 联动 category (collab events not in the 曲谱 StoryLine system).
  const liandongKeys = LIANDONG.filter((b) => bookKeys.has(b));
  for (const b of LIANDONG) if (!bookKeys.has(b)) unmatched.push(`${LIANDONG_LINE}/${b}`);
  result.push([LIANDONG_LINE, liandongKeys]);
  console.log(`  ${LIANDONG_LINE}: ${liandongKeys.length} books`);

  const claimed = new Map();
  for (const [line, keys] of result)
    for (const k of keys) {
      if (claimed.has(k)) console.warn(`  ! "${k}" in both ${claimed.get(k)} and ${line}`);
      else claimed.set(k, line);
    }

  const placed = result.reduce((n, [, k]) => n + k.length, 0);
  const special = [...bookKeys].filter((b) => !claimed.has(b));
  console.log(`\nPlaced ${placed} books across ${result.length} StoryLines; ${special.length} → 特殊.`);
  if (REPORT) {
    console.log(`特殊: ${special.join(", ")}`);
    if (unmatched.length) console.log(`\n乐章 names with no index book (${unmatched.length}): ${unmatched.join(", ")}`);
  }

  await fs.writeFile(OUT_FILE, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT_FILE)}.`);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
