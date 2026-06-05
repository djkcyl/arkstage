import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PROXY_BASE, WIKI_CDN_DOMAINS, proxyUrl, rewriteAllCdnUrls } from "./proxy";

/**
 * Boots the original PRTS ScenarioSimulator engine inside an ISOLATED <iframe>
 * realm. A fresh realm per boot is required because the engine declares top-level
 * `const`s (queue, log_limit_px, $enum, …): re-running it in the main window — e.g.
 * opening a second story, or capturing a manifest while playing — throws
 * "duplicate variable". Using an iframe also means teardown is just iframe.remove()
 * (no global/ timer cleanup, no leakage between stories).
 *
 * "play"    — visible iframe, CDN URLs rewritten to prts-cdn://, runs normally.
 * "manifest"— hidden iframe, RAW CDN URLs, hooks PreloadJS and runs the engine's own
 *             fun_sys_preload() to enumerate a story's deduped asset URLs (no loading).
 */

export interface WidgetBundle {
  dom_html: string;
  data_blocks_html: string;
  engine_scripts: string[];
}

export interface FrameBootOptions {
  /** A freshly created, already-attached iframe to boot the engine into. */
  iframe: HTMLIFrameElement;
  bundle: WidgetBundle;
  /** Raw scenario script (#datas_txt content) for this story. */
  script: string;
  /** Page title, written into #firstHeading (read by data.init()). */
  title: string;
  mode: "play" | "manifest";
  /** Polled between async steps so a cancelled boot can bail early. */
  isCancelled?: () => boolean;
}

export interface FrameBootResult {
  /** In "manifest" mode: the deduped original asset URLs from fun_sys_preload. */
  manifest?: string[];
}

// External engine resources: remote URL + local cache filename.
export const EXTERNALS = {
  css: { url: "https://static.prts.wiki/assets/scenario/arknights-scenario.css", filename: "arknights-scenario.css" },
  jquery: { url: "https://code.jquery.com/jquery-3.7.1.min.js", filename: "jquery.min.js" },
  preloadjs: { url: "https://static.prts.wiki/npm/PreloadJS@1.0.1/preloadjs.min.js", filename: "preloadjs.min.js" },
  toolbox: { url: "https://static.prts.wiki/assets/scenario/krliov.toolbox.js", filename: "krliov.toolbox.js" },
  font: { url: "https://static.prts.wiki/assets/scenario/fonts/NotoSans.ttf", filename: "NotoSans.ttf" },
};

export async function bootEngineInFrame(opts: FrameBootOptions): Promise<FrameBootResult> {
  const { iframe, bundle, script, title, mode } = opts;
  const isCancelled = opts.isCancelled ?? (() => false);
  const play = mode === "play";

  const idoc = iframe.contentDocument;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iwin = iframe.contentWindow as any;
  if (!idoc || !iwin) throw new Error("iframe realm unavailable");

  // MediaWiki shim must exist before engine scripts read mw.config.
  const nickname = localStorage.getItem("prts-nickname") || null;
  iwin.mw = { config: { get: (k: string) => (k === "wgUserName" ? nickname : null) } };

  // === Build the engine document ===
  let dataBlocksHtml = bundle.data_blocks_html.replace(
    /<pre class="hidden" id="datas_txt">[\s\S]*?<\/pre>/,
    `<pre class="hidden" id="datas_txt">${escapeHtml(script)}</pre>`
  );
  // manifest mode keeps RAW CDN URLs so captured assets are original https URLs.
  const domHtml = play ? rewriteAllCdnUrls(bundle.dom_html) : bundle.dom_html;
  if (play) dataBlocksHtml = rewriteAllCdnUrls(dataBlocksHtml);
  const heading = `<h1 id="firstHeading" style="display:none"><span class="mw-page-title-main">${escapeHtml(title)}</span></h1>`;

  idoc.open();
  idoc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000;">${heading}${domHtml}${dataBlocksHtml}</body></html>`);
  idoc.close();

  if (play) {
    // URL-rewrite shim (patches the iframe's own Image/Audio/Source prototypes).
    injectShimInDoc(idoc);
    // Font + CSS.
    const fontUrl = await ensureFontCached();
    await loadCssInDoc(idoc, fontUrl);
  }
  if (isCancelled()) return {};

  // === Load JS deps in order (into the iframe realm) ===
  await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.jquery));
  if (isCancelled()) return {};
  await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.preloadjs));
  if (isCancelled()) return {};
  await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.toolbox));
  if (isCancelled()) return {};

  // === Execute engine scripts (defines data/system/queue/fun_sys_preload, runs fun_sys_init) ===
  for (const code of bundle.engine_scripts) {
    if (isCancelled()) return {};
    execInDoc(idoc, play ? rewriteAllCdnUrls(code) : code);
  }

  if (mode === "manifest") {
    return { manifest: capturePreloadManifest(iwin) };
  }

  // === Play: run jQuery ready (fun_sys_preload + event wiring) and window.onload ===
  processRLQ(iwin);
  triggerWindowOnload(iwin);
  return {};
}

/**
 * Hook the iframe's createjs.LoadQueue.prototype.loadFile to record URLs, run the
 * engine's fun_sys_preload() (which resolves the deduped asset set), then restore.
 * No network happens because queue.load() is never called.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capturePreloadManifest(iwin: any): string[] {
  const captured: string[] = [];
  const proto = iwin.createjs?.LoadQueue?.prototype;
  if (!proto || typeof proto.loadFile !== "function") {
    console.warn("captureManifest: createjs.LoadQueue not available in iframe");
    return [];
  }
  const orig = proto.loadFile;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.loadFile = function (item: any) {
    const url = typeof item === "string" ? item : item?.src ?? item?.path;
    if (typeof url === "string") captured.push(url);
    // Do NOT call orig -> no queueing/loading.
  };
  try {
    if (typeof iwin.fun_sys_preload === "function") iwin.fun_sys_preload();
    else console.warn("captureManifest: fun_sys_preload not defined in iframe");
  } catch (e) {
    console.warn("fun_sys_preload capture error:", e);
  } finally {
    proto.loadFile = orig;
  }
  return Array.from(new Set(captured));
}

// ─── helpers (operate on the iframe's document/window) ──────────────────────

/** Inject the dynamic URL-rewrite shim into a document; it patches that doc's prototypes. */
function injectShimInDoc(idoc: Document): void {
  const shimCode = `
(function() {
  var PROXY_BASE = ${JSON.stringify(PROXY_BASE)};
  var CDN_DOMAINS = ${JSON.stringify(WIKI_CDN_DOMAINS)};
  function rewriteUrl(url) {
    if (typeof url !== 'string') return url;
    for (var i = 0; i < CDN_DOMAINS.length; i++) {
      var d = CDN_DOMAINS[i];
      var https = 'https://' + d + '/', http = 'http://' + d + '/';
      if (url.indexOf(https) === 0) return PROXY_BASE + '/' + d + '/' + url.substring(https.length);
      if (url.indexOf(http) === 0) return PROXY_BASE + '/' + d + '/' + url.substring(http.length);
    }
    return url;
  }
  function patch(proto) {
    var d = Object.getOwnPropertyDescriptor(proto, 'src');
    if (d && d.set) Object.defineProperty(proto, 'src', {
      get: function(){ return d.get.call(this); },
      set: function(v){ d.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }
  patch(HTMLImageElement.prototype);
  patch(HTMLMediaElement.prototype);
  patch(HTMLSourceElement.prototype);
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if ((name === 'src' || name === 'href') && typeof value === 'string') value = rewriteUrl(value);
    return origSetAttr.call(this, name, value);
  };
  window.__prtsRewriteUrl = rewriteUrl;
})();`;
  const s = idoc.createElement("script");
  s.textContent = shimCode;
  s.setAttribute("data-prts-shim", "1");
  (idoc.head || idoc.documentElement).appendChild(s);
}

/** Load CSS into a document: cached text (font + CDN patched), else proxied link. */
async function loadCssInDoc(idoc: Document, localFontUrl: string): Promise<void> {
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
      const style = idoc.createElement("style");
      style.textContent = patched;
      idoc.head.appendChild(style);
      return;
    }
  } catch {
    // fall through
  }
  const link = idoc.createElement("link");
  link.rel = "stylesheet";
  link.href = proxyUrl(EXTERNALS.css.url);
  idoc.head.appendChild(link);
}

/** Download the font if not cached, returning a local asset URL or proxy URL. */
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

/** Resolve an engine dep to a local asset:// URL if cached, else a proxy URL. */
export async function resolveAssetUrl(ext: { url: string; filename: string }): Promise<string> {
  try {
    const localPath = await invoke<string | null>("get_asset_path", {
      category: "engine",
      filename: ext.filename,
    });
    if (localPath) return convertFileSrc(localPath);
  } catch {
    // fall through
  }
  return proxyUrl(ext.url);
}

/** Append a <script src> to a document and resolve when it loads. */
function loadScriptInDoc(idoc: Document, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = idoc.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`dep load failed: ${src}`));
    idoc.body.appendChild(s);
  });
}

/** Execute inline script code inside a document. */
function execInDoc(idoc: Document, code: string): void {
  const s = idoc.createElement("script");
  s.textContent = code;
  idoc.body.appendChild(s);
}

/** Process the MediaWiki Resource Loader Queue inside the iframe (runs document.ready). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processRLQ(iwin: any): void {
  const rlq = iwin.RLQ;
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

/** Trigger window.onload inside the iframe (engine inits the preload system here). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function triggerWindowOnload(iwin: any): void {
  const Ev = iwin.Event || Event;
  if (typeof iwin.onload === "function") {
    try {
      iwin.onload(new Ev("load"));
    } catch (e) {
      console.warn("window.onload error:", e);
    }
  }
  try {
    iwin.dispatchEvent(new Ev("load"));
  } catch {
    // ignore
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
