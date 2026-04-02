import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Story player page — loads the ORIGINAL PRTS ScenarioSimulator engine.
 *
 * 1. Fetch widget bundle (DOM + data blocks + engine scripts) — cached
 * 2. Fetch the specific story's script — cached
 * 3. Build player DOM with original structure
 * 4. Load external deps (jQuery, PreloadJS, toolbox.js, CSS) — prefer local cache
 * 5. Execute engine scripts in order — original engine takes over
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
};

// Track loaded scripts globally so we don't re-add them on React re-renders
const loadedScripts = new Set<string>();

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
    const addedElements: HTMLElement[] = []; // Track elements we add for cleanup

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

        // firstHeading is read by data.init()
        const headingHtml = `<h1 id="firstHeading" style="display:none"><span class="mw-page-title-main">${escapeHtml(decodedTitle)}</span></h1>`;

        container.innerHTML = headingHtml + bundle.dom_html + dataBlocksHtml;

        // === Step 4: Load CSS ===
        if (!document.querySelector(`link[data-prts-css]`)) {
          const cssUrl = await resolveAssetUrl(EXTERNALS.css);
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.type = "text/css";
          link.href = cssUrl;
          link.setAttribute("data-prts-css", "1");
          document.head.appendChild(link);
          addedElements.push(link);
        }

        // === Step 5: Load JS deps in order ===
        await ensureScript("jquery", EXTERNALS.jquery);
        if (cancelled) return;
        await ensureScript("preloadjs", EXTERNALS.preloadjs);
        if (cancelled) return;
        await ensureScript("toolbox", EXTERNALS.toolbox);
        if (cancelled) return;

        // === Step 6: MediaWiki shims ===
        setupMwShims();

        // === Step 7: Execute engine scripts ===
        for (const scriptCode of bundle.engine_scripts) {
          if (cancelled) return;
          const el = executeScript(scriptCode);
          addedElements.push(el);
        }

        // === Step 8: Process RLQ ===
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
      // Stop audio
      document.querySelectorAll("#sys_audio audio").forEach((el) => {
        (el as HTMLAudioElement).pause();
      });
      // Clear timers from the engine
      cleanupEngineTimers();
      // Remove elements we added
      addedElements.forEach((el) => el.remove());
      // Clear container
      container.innerHTML = "";
      // Clean globals
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

/** Try to resolve an asset URL to a locally cached version, fall back to remote. */
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
    // Fall through to remote
  }
  return ext.url;
}

/** Load a script if not already loaded (deduplication). Prefer local cache. */
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
      // If local failed, try remote
      if (url !== ext.url) {
        const fallback = document.createElement("script");
        fallback.src = ext.url;
        fallback.setAttribute("data-prts-script", id);
        fallback.onload = () => {
          loadedScripts.add(id);
          resolve();
        };
        fallback.onerror = () => reject(new Error(`加载失败: ${ext.filename}`));
        document.body.appendChild(fallback);
      } else {
        reject(new Error(`加载失败: ${ext.filename}`));
      }
    };
    document.body.appendChild(script);
  });
}

/** Execute inline script code, returns the created element. */
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

/** Stop engine timers to prevent memory leaks. */
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

/** Clean up global variables the engine creates. */
function cleanupGlobals() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  const globals = [
    "system", "data", "timer", "AnaRes", "$enum", "ResType", "SetType", "LogType",
    "scenario", "pos_multiply", "public_disabled", "queue", "RLQ", "mw",
  ];
  for (const g of globals) {
    try { delete w[g]; } catch { /* non-configurable */ }
  }
  // Remove engine script tags
  document.querySelectorAll("[data-prts-engine]").forEach((el) => el.remove());
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
