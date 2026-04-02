import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Story player page — loads the ORIGINAL PRTS ScenarioSimulator engine.
 *
 * All CDN requests (static.prts.wiki, media.prts.wiki, torappu.prts.wiki)
 * are proxied through a Tauri custom protocol handler (prts-cdn://) that
 * fetches via Rust reqwest with proper Referer header, avoiding 403 errors.
 */

interface WidgetBundle {
  dom_html: string;
  data_blocks_html: string;
  engine_scripts: string[];
}

interface StoryPageData {
  script: string;
  title: string;
}

// Wiki CDN domains that need proxying
const WIKI_CDN_DOMAINS = [
  "static.prts.wiki",
  "media.prts.wiki",
  "torappu.prts.wiki",
];

// Proxy base URL: on Windows WebView2 uses http://{scheme}.localhost
const PROXY_BASE = navigator.userAgent.includes("Windows")
  ? "http://prts-cdn.localhost"
  : "prts-cdn://localhost";

// External resources: remote URL + local cache filename
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

// Track loaded scripts globally so we don't re-add them on React re-renders
const loadedScripts = new Set<string>();

/** Rewrite a single CDN URL to use the proxy protocol. */
function proxyUrl(url: string): string {
  for (const domain of WIKI_CDN_DOMAINS) {
    if (url.startsWith(`https://${domain}/`)) {
      return `${PROXY_BASE}/${domain}/${url.substring(`https://${domain}/`.length)}`;
    }
    if (url.startsWith(`http://${domain}/`)) {
      return `${PROXY_BASE}/${domain}/${url.substring(`http://${domain}/`.length)}`;
    }
  }
  return url;
}

/** Rewrite ALL CDN URLs in a text block (HTML, CSS, etc.) to proxy URLs. */
function rewriteAllCdnUrls(text: string): string {
  for (const domain of WIKI_CDN_DOMAINS) {
    text = text.replaceAll(`https://${domain}/`, `${PROXY_BASE}/${domain}/`);
    text = text.replaceAll(`http://${domain}/`, `${PROXY_BASE}/${domain}/`);
  }
  return text;
}

export default function StoryPlayerPage() {
  const { pageTitle } = useParams<{ pageTitle: string }>();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("正在加载...");
  const [error, setError] = useState<string | null>(null);

  const decodedTitle = pageTitle ? decodeURIComponent(pageTitle) : "";

  useEffect(() => {
    if (!decodedTitle || !containerRef.current) return;

    let cancelled = false;
    const container = containerRef.current;
    const addedElements: HTMLElement[] = [];

    (async () => {
      try {
        // === Step 1: Widget Bundle (cached) ===
        setStatus("正在获取引擎代码...");
        let bundle: WidgetBundle;

        const cachedBundle = await invoke<string | null>("load_from_cache", {
          key: "widget-bundle",
        });

        if (cachedBundle) {
          bundle = JSON.parse(cachedBundle);
        } else {
          bundle = await invoke<WidgetBundle>("fetch_widget_bundle", {
            pageTitle: "W2G/BEG",
          });
          await invoke("save_to_cache", {
            key: "widget-bundle",
            data: JSON.stringify(bundle),
          }).catch(() => {});
        }

        if (cancelled) return;

        // === Step 2: Story Script (cached) ===
        setStatus(`正在获取剧情: ${decodedTitle}...`);
        let storyData: StoryPageData;

        const cacheKey = `stories/${decodedTitle.replace(/\//g, "_")}`;
        const cachedStory = await invoke<string | null>("load_from_cache", {
          key: cacheKey,
        });

        if (cachedStory) {
          storyData = JSON.parse(cachedStory);
        } else {
          storyData = await invoke<StoryPageData>("fetch_story_page", {
            pageTitle: decodedTitle,
          });
          await invoke("save_to_cache", {
            key: cacheKey,
            data: JSON.stringify(storyData),
          }).catch(() => {});
        }

        if (cancelled) return;

        // === Step 3: Build DOM ===
        setStatus("正在初始化播放器...");

        // Replace #datas_txt with this story's script
        let dataBlocksHtml = bundle.data_blocks_html;
        dataBlocksHtml = dataBlocksHtml.replace(
          /<pre class="hidden" id="datas_txt">[\s\S]*?<\/pre>/,
          `<pre class="hidden" id="datas_txt">${escapeHtml(storyData.script)}</pre>`
        );

        // Rewrite ALL CDN URLs in data blocks to use proxy
        dataBlocksHtml = rewriteAllCdnUrls(dataBlocksHtml);

        // Also rewrite CDN URLs in the DOM HTML (UI image references, etc.)
        const domHtml = rewriteAllCdnUrls(bundle.dom_html);

        // firstHeading is read by data.init()
        const headingHtml = `<h1 id="firstHeading" style="display:none"><span class="mw-page-title-main">${escapeHtml(decodedTitle)}</span></h1>`;

        container.innerHTML = headingHtml + domHtml + dataBlocksHtml;

        // === Step 4: Inject URL rewrite shim ===
        // Must be BEFORE any JS deps load so they pick up our overrides
        if (!document.querySelector(`script[data-prts-shim]`)) {
          const shimEl = injectUrlRewriteShim();
          addedElements.push(shimEl);
        }

        // === Step 5: Load font + CSS ===
        const fontUrl = await ensureFontCached();

        if (!document.querySelector(`style[data-prts-css]`)) {
          const cssEl = await loadCssPatched(fontUrl);
          addedElements.push(cssEl);
        }

        // === Step 6: Load JS deps in order ===
        await ensureScript("jquery", EXTERNALS.jquery);
        if (cancelled) return;
        await ensureScript("preloadjs", EXTERNALS.preloadjs);
        if (cancelled) return;
        await ensureScript("toolbox", EXTERNALS.toolbox);
        if (cancelled) return;

        // === Step 7: MediaWiki shims ===
        setupMwShims();

        // === Step 8: Execute engine scripts ===
        // Rewrite CDN URLs in engine script code too
        for (const scriptCode of bundle.engine_scripts) {
          if (cancelled) return;
          const el = executeScript(rewriteAllCdnUrls(scriptCode));
          addedElements.push(el);
        }

        // === Step 9: Process RLQ ===
        processRLQ();

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      document.querySelectorAll("#sys_audio audio").forEach((el) => {
        (el as HTMLAudioElement).pause();
      });
      cleanupEngineTimers();
      addedElements.forEach((el) => el.remove());
      container.innerHTML = "";
      cleanupGlobals();
    };
  }, [decodedTitle]);

  const handleBack = () => {
    navigate("/browse");
  };

  if (error) {
    return (
      <div style={centerStyle}>
        <div style={{ color: "#f44336", marginBottom: "16px" }}>
          加载失败: {error}
        </div>
        <button onClick={handleBack} style={btnStyle}>返回</button>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", background: "#000", position: "relative" }}>
      <button
        onClick={handleBack}
        style={{
          position: "fixed",
          top: "8px",
          left: "8px",
          zIndex: 9999,
          padding: "4px 12px",
          background: "rgba(0,0,0,0.6)",
          color: "white",
          border: "1px solid rgba(255,255,255,0.3)",
          borderRadius: "3px",
          cursor: "pointer",
          fontSize: "13px",
        }}
      >
        ◀ 返回
      </button>

      {loading && (
        <div style={centerStyle}>
          <div style={{ color: "#929292", fontSize: "16px" }}>{status}</div>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: loading ? "none" : "block",
        }}
      />
    </div>
  );
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Inject a JS shim that overrides Image.src, Audio.src, Source.src,
 * and Element.setAttribute to rewrite wiki CDN URLs to proxy URLs.
 * This catches dynamically created elements by the engine at runtime.
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

  // Override HTMLImageElement.src
  var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgDesc && imgDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: function() { return imgDesc.get.call(this); },
      set: function(v) { imgDesc.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }

  // Override HTMLAudioElement.src
  var audioDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (audioDesc && audioDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: function() { return audioDesc.get.call(this); },
      set: function(v) { audioDesc.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }

  // Override HTMLSourceElement.src
  var srcDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLSourceElement.prototype, 'src', {
      get: function() { return srcDesc.get.call(this); },
      set: function(v) { srcDesc.set.call(this, rewriteUrl(v)); },
      configurable: true, enumerable: true
    });
  }

  // Override Element.setAttribute for 'src' and 'href'
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if ((name === 'src' || name === 'href') && typeof value === 'string') {
      value = rewriteUrl(value);
    }
    return origSetAttr.call(this, name, value);
  };

  // Expose for debugging
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
    if (existing) {
      return convertFileSrc(existing);
    }
    const localPath = await invoke<string>("download_asset", {
      url: EXTERNALS.font.url,
      category: "engine",
      filename: EXTERNALS.font.filename,
    });
    return convertFileSrc(localPath);
  } catch {
    // Fall back to proxied URL
    return proxyUrl(EXTERNALS.font.url);
  }
}

/**
 * Load CSS: prefer cached text (with font + CDN URLs patched),
 * fall back to proxied remote URL.
 */
async function loadCssPatched(localFontUrl: string): Promise<HTMLElement> {
  try {
    const cssText = await invoke<string | null>("read_asset_text", {
      category: "engine",
      filename: EXTERNALS.css.filename,
    });
    if (cssText) {
      // Replace font URL and all CDN URLs
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

  // Fallback: load via proxy URL
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
    if (localPath) {
      return convertFileSrc(localPath);
    }
  } catch {
    // Fall through
  }
  // Use proxy instead of direct CDN URL
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
      // If local/proxy failed, try proxy (if was local) or direct CDN as last resort
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
        get: (key: string) => {
          if (key === "wgUserName") return nickname;
          return null;
        },
      },
    };
  }
}

/** Process MediaWiki Resource Loader Queue. */
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

function cleanupEngineTimers() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  try {
    if (w.timer && typeof w.timer.clearAll === "function") {
      w.timer.clearAll();
    }
  } catch {
    // Ignore
  }
}

function cleanupGlobals() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const globals = [
    "system", "data", "timer", "AnaRes", "$enum", "ResType", "SetType", "LogType",
    "scenario", "pos_multiply", "public_disabled", "queue", "RLQ", "mw",
    "__prtsRewriteUrl", "__prtsProxyBase",
  ];
  for (const g of globals) {
    try { delete w[g]; } catch { /* non-configurable */ }
  }
  document.querySelectorAll("[data-prts-engine]").forEach((el) => el.remove());
  document.querySelectorAll("[data-prts-shim]").forEach((el) => el.remove());
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const centerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  flexDirection: "column",
  gap: "16px",
  background: "#000",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 20px",
  background: "#f4c430",
  color: "#000",
  border: "none",
  borderRadius: "4px",
  fontSize: "14px",
  cursor: "pointer",
};
