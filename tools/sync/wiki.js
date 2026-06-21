// prts.wiki page fetching + cheerio ports of the Rust parsers.
//
// Ported from:
//   src-tauri/src/commands/wiki.rs      — URL forms (page = /w/<urlencoded title>)
//   src-tauri/src/parser/story_index.rs — parse_story_index (剧情一览 wikitable)
//   src-tauri/src/parser/story_page.rs  — extract_widget_html / extract_story_script

import * as cheerio from "cheerio";
import { createLimiter, sleep } from "./throttle.js";

const USER_AGENT =
  "ArkstageSync/0.1 (+https://github.com/djkcyl/prts-reader) Node puppeteer-core";

// Throttle ALL prts.wiki *page* GETs through one limiter + a min spacing, so the
// orchestrator can't hammer the wiki even when fetching many story pages.
const pageLimiter = createLimiter(2);
let lastPageAt = 0;
const MIN_PAGE_SPACING_MS = 300;

/**
 * GET a prts.wiki page's raw HTML. Throttled (≤2 concurrent, min spacing).
 * Mirrors `fetch_page_raw`: url = https://prts.wiki/w/<urlencoded title>.
 * @param {string} title page title (e.g. "W2G/BEG", "剧情一览")
 * @returns {Promise<string>} raw HTML
 */
export function fetchPage(title) {
  return pageLimiter(async () => {
    const since = Date.now() - lastPageAt;
    if (since < MIN_PAGE_SPACING_MS) await sleep(MIN_PAGE_SPACING_MS - since);
    lastPageAt = Date.now();

    const url = `https://prts.wiki/w/${encodeURIComponent(title)}`;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
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
  });
}

/**
 * Port of `extract_story_script` (story_page.rs): pull #datas_txt text + the page
 * title from #firstHeading.
 * @param {string} html
 * @returns {{ script: string, title: string } | null}
 */
export function extractStoryScript(html) {
  const $ = cheerio.load(html);
  const pre = $("#datas_txt").first();
  if (pre.length === 0) return null;
  // .text() yields the decoded text content (entities resolved), as in Rust el.text().
  const script = pre.text();
  const title = $("#firstHeading").first().text().trim();
  return { script, title };
}

/**
 * Port of `extract_widget_html` (story_page.rs): the DOM, the data <pre> blocks,
 * and the inline engine <script> blocks needed to run the ScenarioSimulator.
 * @param {string} html
 * @returns {{ dom_html: string, data_blocks_html: string, engine_scripts: string[] }}
 */
export function extractWidgetBundle(html) {
  const $ = cheerio.load(html);

  // 1) #sys_fullscreen + #sys_audio inner HTML, re-wrapped to match Rust output.
  const fullscreen = $("#sys_fullscreen").first().html() || "";
  const audio = $("#sys_audio").first().html() || "";
  const dom_html =
    `<div class="common_style" id="sys_fullscreen">${fullscreen}</div>\n` +
    `<div id="sys_audio" style="display:none;">${audio}</div>`;

  // 2) data blocks as raw <pre> elements.
  const getPre = (id) => {
    const el = $(`#${id}`).first();
    if (el.length === 0) return "";
    return `<pre class="hidden" id="${id}">${el.html()}</pre>`;
  };
  const data_blocks_html = [
    getPre("datas_txt"),
    getPre("datas_back"),
    getPre("datas_char"),
    getPre("datas_audio"),
    getPre("datas_link"),
    getPre("datas_override"),
  ].join("\n");

  // 3) inline <script class="navigation-not-searchable"> blocks. The Rust code does
  //    raw string matching because the scraper crate strips <script> content; cheerio
  //    preserves it, but we mirror the exact same selection (this class only) and the
  //    string approach as a fallback to be safe.
  const engine_scripts = extractInlineScripts(html);

  return { dom_html, data_blocks_html, engine_scripts };
}

/**
 * Port of `extract_inline_scripts` — raw string match of
 * <script class="navigation-not-searchable">…</script> blocks, trimmed, non-empty.
 * @param {string} html
 * @returns {string[]}
 */
function extractInlineScripts(html) {
  const openTag = '<script class="navigation-not-searchable">';
  const closeTag = "</script>";
  const scripts = [];
  let searchFrom = 0;
  for (;;) {
    const start = html.indexOf(openTag, searchFrom);
    if (start === -1) break;
    const absStart = start + openTag.length;
    const end = html.indexOf(closeTag, absStart);
    if (end === -1) break;
    const content = html.slice(absStart, end).trim();
    if (content) scripts.push(content);
    searchFrom = end + closeTag.length;
  }
  return scripts;
}

/**
 * Port of `parse_story_index` (story_index.rs): 剧情一览 wikitable → categories.
 * Produces the SAME structure as the Rust app:
 *   { categories: [{ name, chapters: [{ name, activityName, stories: [{ title, pageTitle }] }] }] }
 * @param {string} html
 * @returns {{ categories: Array<{ name: string, chapters: Array<{ name: string, activityName: string | null, stories: Array<{ title: string, pageTitle: string }> }> }> }}
 */
export function parseStoryIndex(html) {
  const $ = cheerio.load(html);
  const categories = [];

  $("table.wikitable").each((_, table) => {
    const $table = $(table);
    const rows = $table.find("tr").toArray();
    if (rows.length === 0) return;

    // First row's first <th> (colspan) is the category title.
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
        // Continuation row inside a rowspan group.
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

      // Don't repeat the activity label when it equals the leaf name.
      if (activityName !== null && activityName === chapterName) activityName = null;

      // Story links from the last td.
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
        stories.push({ title: displayText, pageTitle });
      });

      if (stories.length > 0) {
        chapters.push({ name: chapterName, activityName, stories });
      }
    }

    if (chapters.length > 0) {
      categories.push({ name: categoryName, chapters });
    }
  });

  return { categories };
}
