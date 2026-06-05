import { invoke } from "@tauri-apps/api/core";
import { bootEngine, cleanupGlobals } from "./engineBoot";
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

/** Boot the engine for one story in a hidden container and return its deduped asset URLs. */
export async function captureManifest(
  bundle: WidgetBundle,
  script: string,
  title: string
): Promise<string[]> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:960px;height:540px;";
  document.body.appendChild(host);
  let result: string[] = [];
  let added: HTMLElement[] = [];
  try {
    const r = await bootEngine({
      container: host,
      bundle,
      script,
      title,
      mode: "manifest",
      isCancelled: () => false,
    });
    result = r.manifest ?? [];
    added = r.addedElements;
  } finally {
    added.forEach((el) => el.remove());
    host.remove();
    cleanupGlobals();
  }
  return result;
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
