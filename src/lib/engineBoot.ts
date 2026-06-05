import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PROXY_BASE, WIKI_CDN_DOMAINS, proxyUrl, rewriteAllCdnUrls } from "./proxy";

/**
 * Reusable boot logic for the original PRTS ScenarioSimulator engine.
 *
 * "play" mode injects the engine into a visible container and runs it normally
 * (CDN URLs rewritten to the prts-cdn:// proxy). "manifest" mode boots the engine
 * with RAW CDN URLs, hooks PreloadJS so it can run the engine's own fun_sys_preload()
 * to enumerate the exact deduped asset URLs for a story WITHOUT loading them.
 */

export interface WidgetBundle {
  dom_html: string;
  data_blocks_html: string;
  engine_scripts: string[];
}

export interface BootOptions {
  container: HTMLElement;
  bundle: WidgetBundle;
  /** Raw scenario script (#datas_txt content) for this story. */
  script: string;
  /** Page title, written into #firstHeading (read by data.init()). */
  title: string;
  /** "play": run normally. "manifest": capture the preload asset set, don't load. */
  mode: "play" | "manifest";
  /** Polled between async steps so a cancelled boot can bail early. */
  isCancelled: () => boolean;
}

export interface BootResult {
  /** Elements appended to <head>/<body> so the caller can remove them on teardown. */
  addedElements: HTMLElement[];
  /** In "manifest" mode: the deduped original asset URLs from fun_sys_preload. */
  manifest?: string[];
}

// External engine resources: remote URL + local cache filename.
const EXTERNALS = {
  css: {
    url: "https://static.prts.wiki/assets/scenario/arknights-scenario.css",
    filename: "arknights-scenario.css",
  },
  jquery: {
    url: "https://code.jquery.com/jquery-3.7.1.min.js",
    filename: "jquery.min.js",
  },
  preloadjs: {
    url: "https://static.prts.wiki/npm/PreloadJS@1.0.1/preloadjs.min.js",
    filename: "preloadjs.min.js",
  },
  toolbox: {
    url: "https://static.prts.wiki/assets/scenario/krliov.toolbox.js",
    filename: "krliov.toolbox.js",
  },
  font: {
    url: "https://static.prts.wiki/assets/scenario/fonts/NotoSans.ttf",
    filename: "NotoSans.ttf",
  },
};

// Track loaded scripts globally so we don't re-add them on React re-renders.
const loadedScripts = new Set<string>();

export async function bootEngine(opts: BootOptions): Promise<BootResult> {
  const { container, bundle, script, title, mode, isCancelled } = opts;
  const addedElements: HTMLElement[] = [];

  // === Build DOM ===
  // Replace #datas_txt with this story's script.
  let dataBlocksHtml = bundle.data_blocks_html.replace(
    /<pre class="hidden" id="datas_txt">[\s\S]*?<\/pre>/,
    `<pre class="hidden" id="datas_txt">${escapeHtml(script)}</pre>`
  );
  // In manifest mode keep RAW CDN URLs so captured assets are original https URLs.
  const domHtml = mode === "play" ? rewriteAllCdnUrls(bundle.dom_html) : bundle.dom_html;
  if (mode === "play") dataBlocksHtml = rewriteAllCdnUrls(dataBlocksHtml);

  // firstHeading is read by data.init().
  const headingHtml = `<h1 id="firstHeading" style="display:none"><span class="mw-page-title-main">${escapeHtml(title)}</span></h1>`;
  container.innerHTML = headingHtml + domHtml + dataBlocksHtml;

  // === Inject URL rewrite shim (before any deps load) ===
  if (!document.querySelector(`script[data-prts-shim]`)) {
    addedElements.push(injectUrlRewriteShim());
  }

  // === Font + CSS (play mode only; not needed to enumerate URLs) ===
  if (mode === "play") {
    const fontUrl = await ensureFontCached();
    if (!document.querySelector(`style[data-prts-css]`)) {
      addedElements.push(await loadCssPatched(fontUrl));
    }
  }
  if (isCancelled()) return { addedElements };

  // === Load JS deps in order ===
  await ensureScript("jquery", EXTERNALS.jquery);
  if (isCancelled()) return { addedElements };
  await ensureScript("preloadjs", EXTERNALS.preloadjs);
  if (isCancelled()) return { addedElements };
  await ensureScript("toolbox", EXTERNALS.toolbox);
  if (isCancelled()) return { addedElements };

  // === MediaWiki shims ===
  setupMwShims();

  // === Execute engine scripts (defines data, system, queue, fun_sys_preload, ...) ===
  for (const scriptCode of bundle.engine_scripts) {
    if (isCancelled()) return { addedElements };
    const code = mode === "play" ? rewriteAllCdnUrls(scriptCode) : scriptCode;
    addedElements.push(executeScript(code));
  }

  if (mode === "manifest") {
    // Hook PreloadJS at the prototype level (the engine's `queue` is a script-scoped
    // const, not on window), run fun_sys_preload, and capture the queued URLs.
    const manifest = capturePreloadManifest();
    return { addedElements, manifest };
  }

  // === Process RLQ (runs jQuery ready -> fun_sys_preload + event wiring) ===
  processRLQ();

  // === Trigger window.onload (engine inits preload system here) ===
  triggerWindowOnload();

  return { addedElements };
}

/**
 * Override createjs.LoadQueue.prototype.loadFile to record URLs, call the engine's
 * own fun_sys_preload() (which resolves the deduped asset set), then restore.
 * No network happens because queue.load() is never called.
 */
function capturePreloadManifest(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const captured: string[] = [];
  const proto = w.createjs?.LoadQueue?.prototype;
  if (!proto || typeof proto.loadFile !== "function") {
    console.warn("captureManifest: createjs.LoadQueue not available");
    return [];
  }
  const orig = proto.loadFile;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.loadFile = function (item: any) {
    const url = typeof item === "string" ? item : item?.src ?? item?.path;
    if (typeof url === "string") captured.push(url);
    // Intentionally do NOT call orig -> avoid queueing/loading.
  };
  try {
    if (typeof w.fun_sys_preload === "function") w.fun_sys_preload();
    else console.warn("captureManifest: fun_sys_preload not defined");
  } catch (e) {
    console.warn("fun_sys_preload capture error:", e);
  } finally {
    proto.loadFile = orig;
  }
  return Array.from(new Set(captured));
}

// ─── Helpers (moved verbatim from StoryPlayerPage) ──────────────────────────

/**
 * Inject a JS shim that rewrites wiki CDN URLs to proxy URLs for elements the
 * engine creates dynamically at runtime (Image/Audio/Source.src, setAttribute).
 */
function injectUrlRewriteShim(): HTMLScriptElement {
  const shimCode = `
(function() {
  var PROXY_BASE = ${JSON.stringify(PROXY_BASE)};
  var CDN_DOMAINS = ${JSON.stringify(WIKI_CDN_DOMAINS)};

  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    for (var i = 0; i < CDN_DOMAINS.length; i++) {
      var d = CDN_DOMAINS[i];
      var https = 'https://' + d + '/';
      var http = 'http://' + d + '/';
      if (url.indexOf(https) === 0) return PROXY_BASE + '/' + d + '/' + url.substring(https.length);
      if (url.indexOf(http) === 0) return PROXY_BASE + '/' + d + '/' + url.substring(http.length);
    }
    return url;
  }

  var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgDesc && imgDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: function() { return imgDesc.get.call(this); },
      set: function(v) { imgDesc.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }

  var audioDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (audioDesc && audioDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: function() { return audioDesc.get.call(this); },
      set: function(v) { audioDesc.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }

  var srcDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLSourceElement.prototype, 'src', {
      get: function() { return srcDesc.get.call(this); },
      set: function(v) { srcDesc.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }

  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if ((name === 'src' || name === 'href') && typeof value === 'string') {
      value = rewriteUrl(value);
    }
    return origSetAttr.call(this, name, value);
  };

  window.__prtsRewriteUrl = rewriteUrl;
  window.__prtsProxyBase = PROXY_BASE;
})();
`;
  const script = document.createElement("script");
  script.textContent = shimCode;
  script.setAttribute("data-prts-shim", "1");
  document.head.appendChild(script);
  return script;
}

/** Download font if not cached, return local asset URL or proxy URL. */
async function ensureFontCached(): Promise<string> {
  try {
    const existing = await invoke<string | null>("get_asset_path", {
      category: "engine",
      filename: EXTERNALS.font.filename,
    });
    if (existing) return convertFileSrc(existing);
    const localPath = await invoke<string>("download_asset", {
      url: EXTERNALS.font.url,
      category: "engine",
      filename: EXTERNALS.font.filename,
    });
    return convertFileSrc(localPath);
  } catch {
    return proxyUrl(EXTERNALS.font.url);
  }
}

/** Load CSS: prefer cached text (font + CDN URLs patched), fall back to proxied URL. */
async function loadCssPatched(localFontUrl: string): Promise<HTMLElement> {
  try {
    const cssText = await invoke<string | null>("read_asset_text", {
      category: "engine",
      filename: EXTERNALS.css.filename,
    });
    if (cssText) {
      let patched = cssText.replace(
        /url\(['"]?https:\/\/static\.prts\.wiki\/assets\/scenario\/fonts\/NotoSans\.ttf['"]?\)/g,
        `url("${localFontUrl}")`
      );
      patched = rewriteAllCdnUrls(patched);
      const style = document.createElement("style");
      style.setAttribute("data-prts-css", "1");
      style.textContent = patched;
      document.head.appendChild(style);
      return style;
    }
  } catch {
    // Fall through
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = proxyUrl(EXTERNALS.css.url);
  link.setAttribute("data-prts-css", "1");
  document.head.appendChild(link);
  return link;
}

/** Try local cache first, fall back to proxy URL (not direct CDN). */
async function resolveAssetUrl(ext: { url: string; filename: string }): Promise<string> {
  try {
    const localPath = await invoke<string | null>("get_asset_path", {
      category: "engine",
      filename: ext.filename,
    });
    if (localPath) return convertFileSrc(localPath);
  } catch {
    // Fall through
  }
  return proxyUrl(ext.url);
}

/** Load a script if not already loaded. Prefer local cache, fall back to proxy. */
async function ensureScript(id: string, ext: { url: string; filename: string }): Promise<void> {
  if (loadedScripts.has(id)) return;
  const url = await resolveAssetUrl(ext);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.setAttribute("data-prts-script", id);
    script.onload = () => {
      loadedScripts.add(id);
      resolve();
    };
    script.onerror = () => {
      const fallbackUrl = url !== proxyUrl(ext.url) ? proxyUrl(ext.url) : ext.url;
      const fallback = document.createElement("script");
      fallback.src = fallbackUrl;
      fallback.setAttribute("data-prts-script", id);
      fallback.onload = () => {
        loadedScripts.add(id);
        resolve();
      };
      fallback.onerror = () => reject(new Error(`加载失败: ${ext.filename}`));
      document.body.appendChild(fallback);
    };
    document.body.appendChild(script);
  });
}

/** Execute inline script code. */
function executeScript(code: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.textContent = code;
  script.setAttribute("data-prts-engine", "1");
  document.body.appendChild(script);
  return script;
}

/** MediaWiki API shims. */
function setupMwShims() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (!w.mw) {
    const nickname = localStorage.getItem("prts-nickname") || null;
    w.mw = {
      config: {
        get: (key: string) => (key === "wgUserName" ? nickname : null),
      },
    };
  }
}

/** Process MediaWiki Resource Loader Queue (runs the jQuery document.ready handler). */
function processRLQ() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const rlq = w.RLQ;
  if (rlq && Array.isArray(rlq)) {
    for (const entry of rlq) {
      if (Array.isArray(entry) && entry[0] === "jquery" && typeof entry[1] === "function") {
        try {
          entry[1]();
        } catch (e) {
          console.warn("RLQ callback error:", e);
        }
      }
    }
  }
}

/** Trigger window.onload for the engine (SPA already fired load). */
function triggerWindowOnload() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (typeof w.onload === "function") {
    try {
      w.onload(new Event("load"));
    } catch (e) {
      console.warn("window.onload error:", e);
    }
  }
  window.dispatchEvent(new Event("load"));
}

export function cleanupEngineTimers() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  try {
    if (w.timer && typeof w.timer.clearAll === "function") w.timer.clearAll();
  } catch {
    // Ignore
  }
}

export function cleanupGlobals() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const globals = [
    "system", "data", "timer", "AnaRes", "$enum", "ResType", "SetType", "LogType",
    "scenario", "pos_multiply", "public_disabled", "queue", "RLQ", "mw",
    "__prtsRewriteUrl", "__prtsProxyBase",
  ];
  for (const g of globals) {
    try {
      delete w[g];
    } catch {
      /* non-configurable */
    }
  }
  document.querySelectorAll("[data-prts-engine]").forEach((el) => el.remove());
  document.querySelectorAll("[data-prts-shim]").forEach((el) => el.remove());
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
