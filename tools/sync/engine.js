// The linchpin: boot the original PRTS ScenarioSimulator engine in headless Chrome
// and capture a story's deduped asset manifest via fun_sys_preload().
//
// Ported from frontend/src/lib/engineBoot.ts (bootEngineInFrame + capturePreloadManifest),
// simplified for REAL headless Chrome where the WebView2/WebKitGTK quirks don't apply:
//   - inline <script> executes fine (no blob-URL trick needed)
//   - innerText works (keep an off-screen #firstHeading for data.init())
//   - no CSP / no URL-rewrite shim (manifest mode keeps RAW CDN urls anyway)

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalKey } from "./canonicalKey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Engine dep URLs (from EXTERNALS in engineBoot.ts). jQuery is bundled in the app;
// preloadjs + toolbox live on the prts CDN. css/font aren't needed for manifest
// capture (no rendering), so we skip them.
const BUNDLED_JQUERY = path.resolve(
  __dirname,
  "../../frontend/public/vendor/jquery.min.js"
);
const DEP_URLS = {
  preloadjs: "https://static.prts.wiki/npm/PreloadJS@1.0.1/preloadjs.min.js",
  toolbox: "https://static.prts.wiki/assets/scenario/krliov.toolbox.js",
};

const CACHE_DIR = path.resolve(__dirname, ".depcache");

/** @type {{ jquery: string, preloadjs: string, toolbox: string } | null} */
let depCache = null;

/**
 * Pre-download the engine deps ONCE into memory (cached on disk too) so every page
 * boot loads them inline and offline-stable. Returns the JS source strings.
 */
export async function prewarmEngineDeps() {
  if (depCache) return depCache;
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const jquery = await fs.readFile(BUNDLED_JQUERY, "utf8");
  const [preloadjs, toolbox] = await Promise.all([
    fetchDepCached("preloadjs.min.js", DEP_URLS.preloadjs),
    fetchDepCached("krliov.toolbox.js", DEP_URLS.toolbox),
  ]);

  depCache = { jquery, preloadjs, toolbox };
  return depCache;
}

/**
 * Read a dep from the on-disk cache or download it once.
 * @param {string} filename
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchDepCached(filename, url) {
  const file = path.join(CACHE_DIR, filename);
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    // not cached
  }
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "ArkstageSync/0.1",
      Referer: "https://prts.wiki/",
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) throw new Error(`engine dep fetch ${url} -> HTTP ${resp.status}`);
  const text = await resp.text();
  await fs.writeFile(file, text, "utf8");
  return text;
}

/** Escape for embedding into HTML text content (mirrors escapeHtml in engineBoot.ts). */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Capture a story's deduped asset manifest as canonical keys.
 * @param {import("puppeteer-core").Browser} browser
 * @param {{ dom_html: string, data_blocks_html: string, engine_scripts: string[] }} bundle widget bundle (from W2G/BEG, reused for all stories)
 * @param {string} script the per-story #datas_txt script text
 * @param {string} title page title (written into #firstHeading; read by data.init())
 * @returns {Promise<string[]>} canonical keys (deduped, nulls dropped)
 */
export async function captureManifest(browser, bundle, script, title) {
  const deps = await prewarmEngineDeps();

  // Inject the per-story script into the shared bundle's #datas_txt block, exactly
  // as bootEngineInFrame does (it replaces the whole <pre id="datas_txt">…</pre>).
  const dataBlocksHtml = bundle.data_blocks_html.replace(
    /<pre class="hidden" id="datas_txt">[\s\S]*?<\/pre>/,
    `<pre class="hidden" id="datas_txt">${escapeHtml(script)}</pre>`
  );

  // Off-screen #firstHeading: the engine reads tarObj.innerText in data.init().
  const heading =
    `<h1 id="firstHeading" style="position:absolute;left:-99999px;top:0">` +
    `<span class="mw-page-title-main">${escapeHtml(title)}</span></h1>`;

  const baseStyle =
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#000;}</style>";

  // Assemble the full document. Engine deps + engine scripts run inline (works in
  // real Chrome). A leading shim defines the MediaWiki `mw` stub the engine reads.
  const mwShim =
    "<script>window.mw={config:{get:function(k){return k==='wgUserName'?null:null;}}};</script>";

  const depScripts =
    `<script>${deps.jquery}</script>` +
    `<script>${deps.preloadjs}</script>` +
    `<script>${deps.toolbox}</script>`;

  const engineScripts = bundle.engine_scripts
    .map((code) => `<script>${code}</script>`)
    .join("\n");

  const doc =
    `<!DOCTYPE html><html><head><meta charset="utf-8">${baseStyle}${mwShim}</head>` +
    `<body style="margin:0;background:#000;">${heading}${bundle.dom_html}${dataBlocksHtml}` +
    `${depScripts}${engineScripts}</body></html>`;

  const page = await browser.newPage();
  try {
    // Block ALL network: manifest capture must not load any asset. about:blank +
    // setContent with waitUntil 'load' lets inline scripts run; we abort any
    // sub-resource request (the engine deps are inline, so nothing legit is blocked).
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.isInterceptedRequestHandled?.()) return;
      const t = req.resourceType();
      if (t === "document") req.continue();
      else req.abort().catch(() => {});
    });

    await page.setContent(doc, { waitUntil: "load", timeout: 60_000 });

    // In the real engine, jQuery's ready callback (queued in RLQ) runs fun_sys_init
    // which defines fun_sys_preload. setContent already fired DOMContentLoaded/load,
    // so $(document).ready handlers have executed. Verify + run the manifest capture.
    const result = await page.evaluate(() => {
      const out = { defined: false, count: 0, urls: [], probe: {} };
      const w = window;
      out.probe = {
        jQuery: typeof w.$,
        createjs: typeof w.createjs,
        system: typeof w.system,
        fun_sys_preload: typeof w.fun_sys_preload,
      };
      const proto = w.createjs && w.createjs.LoadQueue && w.createjs.LoadQueue.prototype;
      if (!proto || typeof proto.loadFile !== "function") {
        return out;
      }
      if (typeof w.fun_sys_preload !== "function") {
        return out;
      }
      out.defined = true;
      const captured = [];
      const orig = proto.loadFile;
      proto.loadFile = function (item) {
        const url =
          typeof item === "string" ? item : (item && (item.src || item.path)) || null;
        if (typeof url === "string") captured.push(url);
        // Do NOT call orig -> no queueing/loading/network.
      };
      try {
        w.fun_sys_preload();
      } catch (e) {
        out.error = String((e && e.message) || e);
      } finally {
        proto.loadFile = orig;
      }
      const uniq = Array.from(new Set(captured));
      out.count = uniq.length;
      out.urls = uniq;
      return out;
    });

    if (!result.defined) {
      throw new Error(
        `fun_sys_preload not available for "${title}". probe=${JSON.stringify(
          result.probe
        )}`
      );
    }

    // Map raw URLs through canonicalKey, drop nulls, dedupe.
    const keys = [];
    const seen = new Set();
    for (const raw of result.urls) {
      const key = canonicalKey(raw);
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    return keys;
  } finally {
    await page.close().catch(() => {});
  }
}
