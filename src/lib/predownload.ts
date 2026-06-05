import { invoke } from "@tauri-apps/api/core";
import { EXTERNALS, escapeHtml, resolveAssetUrl } from "./engineBoot";
import type { WidgetBundle } from "./engineBoot";

export interface BatchResult {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface PreProgress {
  phase: "manifest" | "download";
  done: number;
  total: number;
  label: string;
}

/** Load the shared widget bundle (engine DOM + scripts + global databases). */
export async function loadBundle(): Promise<WidgetBundle> {
  const cached = await invoke<string | null>("load_from_cache", { key: "widget-bundle-v2" });
  if (cached) return JSON.parse(cached) as WidgetBundle;
  const b = await invoke<WidgetBundle>("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
  await invoke("save_to_cache", { key: "widget-bundle-v2", data: JSON.stringify(b) }).catch(() => {});
  return b;
}

/** Fetch+cache a story's script if needed, returning its raw scenario text. */
export async function ensureScript(title: string): Promise<string> {
  const key = `stories_${title.replace(/\//g, "_")}`;
  const cached = await invoke<string | null>("load_from_cache", { key });
  if (cached) return (JSON.parse(cached) as { script: string }).script;
  const data = await invoke<{ script: string; title: string }>("fetch_story_page", {
    pageTitle: title,
  });
  await invoke("save_to_cache", { key, data: JSON.stringify(data) }).catch(() => {});
  return data.script;
}

/** Load a <script src> into a document and resolve when it finishes loading. */
function loadScriptInDoc(idoc: Document, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = idoc.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`dep load failed: ${src}`));
    idoc.body.appendChild(s);
  });
}

/**
 * Boot the engine for one story inside an ISOLATED iframe realm and return its
 * deduped asset URLs, by hooking PreloadJS and running the engine's own
 * fun_sys_preload(). An iframe is required because the engine declares top-level
 * `const`s — re-running it in the main window realm throws "duplicate variable".
 * No media is fetched (queue.load() is never called); only URL strings are built.
 */
export async function captureManifest(
  bundle: WidgetBundle,
  script: string,
  title: string
): Promise<string[]> {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-99999px;top:0;width:960px;height:540px;border:0;";
  document.body.appendChild(iframe);
  try {
    const idoc = iframe.contentDocument;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iwin = iframe.contentWindow as any;
    if (!idoc || !iwin) throw new Error("iframe realm unavailable");

    // MediaWiki shim must exist before engine scripts read mw.config.
    const nickname = localStorage.getItem("prts-nickname") || null;
    iwin.mw = { config: { get: (k: string) => (k === "wgUserName" ? nickname : null) } };

    // Data blocks keep RAW CDN URLs so captured assets are original https URLs.
    const dataBlocksHtml = bundle.data_blocks_html.replace(
      /<pre class="hidden" id="datas_txt">[\s\S]*?<\/pre>/,
      `<pre class="hidden" id="datas_txt">${escapeHtml(script)}</pre>`
    );
    const heading = `<h1 id="firstHeading" style="display:none"><span class="mw-page-title-main">${escapeHtml(title)}</span></h1>`;
    idoc.open();
    idoc.write(`<!DOCTYPE html><html><head></head><body>${heading}${bundle.dom_html}${dataBlocksHtml}</body></html>`);
    idoc.close();

    // Load engine deps into the iframe realm (cached asset:// or proxy URL).
    await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.jquery));
    await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.preloadjs));
    await loadScriptInDoc(idoc, await resolveAssetUrl(EXTERNALS.toolbox));

    // Execute engine scripts (defines data/system/queue/fun_sys_preload, runs fun_sys_init).
    for (const code of bundle.engine_scripts) {
      const s = idoc.createElement("script");
      s.textContent = code;
      idoc.body.appendChild(s);
    }

    // Hook PreloadJS in the iframe realm, run the engine's preload resolver, capture URLs.
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
  } finally {
    iframe.remove();
  }
}

/** Capture manifests for many stories, union+dedup, then batch download missing assets. */
export async function predownloadScope(
  titles: string[],
  onProgress: (p: PreProgress) => void
): Promise<{ assets: number; result: BatchResult }> {
  const bundle = await loadBundle();
  const union = new Set<string>();
  for (let i = 0; i < titles.length; i++) {
    onProgress({ phase: "manifest", done: i, total: titles.length, label: titles[i] });
    try {
      const script = await ensureScript(titles[i]);
      const urls = await captureManifest(bundle, script, titles[i]);
      urls.forEach((u) => union.add(u));
    } catch (e) {
      console.warn("manifest failed for", titles[i], e);
    }
  }
  onProgress({ phase: "download", done: 0, total: union.size, label: "下载中" });
  const result = await invoke<BatchResult>("batch_download_assets", { urls: Array.from(union) });
  return { assets: union.size, result };
}
