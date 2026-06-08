import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bootEngineInFrame } from "./engineBoot";
import type { WidgetBundle } from "./engineBoot";

/**
 * Predownload status. Indexing (manifest) and downloading run CONCURRENTLY now
 * (each parsed story's assets are streamed to the downloader immediately), so
 * this carries both phases' progress at once — the UI shows two progress bars.
 */
export interface PredownloadStatus {
  paused: boolean;
  // 索引 (manifest) phase
  manifestDone: number;
  manifestTotal: number;
  manifestActive: boolean; // still indexing stories
  // 下载 (download) phase
  done: number;
  total: number; // known assets so far (grows while indexing)
  success: number;
  failed: number;
  skipped: number;
  bytesPerSec: number;
}

/** One control surface that pauses/cancels both phases together. */
export interface PredownloadSession {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

/** Live snapshot of a managed download job (mirrors download::Snapshot in Rust). */
export interface JobSnapshot {
  id: number;
  status: "running" | "paused" | "completed" | "cancelled";
  total: number;
  done: number;
  success: number;
  failed: number;
  skipped: number;
  bytes: number;
  bytesPerSec: number;
}

/** True when an error string came from the backend offline gate. */
export function isOfflineError(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).includes("PRTS_OFFLINE");
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

/**
 * Boot the engine for one story inside an isolated, hidden iframe and return its
 * deduped asset URLs (via bootEngineInFrame's manifest mode). No media is fetched.
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
    const { manifest } = await bootEngineInFrame({ iframe, bundle, script, title, mode: "manifest" });
    return manifest ?? [];
  } finally {
    iframe.remove();
  }
}

/**
 * Captured asset-URL manifest for one story, **cached** under `manifest_<title>`
 * so we don't re-boot the engine (and don't re-fetch the script) on every
 * predownload. A cache hit needs no network at all — important for offline reuse
 * and for breakpoint-resume (a re-run skips already-parsed stories instantly).
 */
export async function manifestForStory(bundle: WidgetBundle, title: string): Promise<string[]> {
  const key = `manifest_${title.replace(/\//g, "_")}`;
  const cached = await invoke<string | null>("load_from_cache", { key });
  if (cached) return JSON.parse(cached) as string[];
  const script = await ensureScript(title); // may fetch (online); throws if offline+uncached
  const urls = await captureManifest(bundle, script, title);
  await invoke("save_to_cache", { key, data: JSON.stringify(urls) }).catch(() => {});
  return urls;
}

/** Frontend pause/cancel gate for the (engine-driven) manifest phase. */
class PauseGate {
  private _paused = false;
  private _cancelled = false;
  private waiters: Array<() => void> = [];
  get paused() {
    return this._paused;
  }
  get cancelled() {
    return this._cancelled;
  }
  pause() {
    this._paused = true;
  }
  resume() {
    this._paused = false;
    this.flush();
  }
  cancel() {
    this._cancelled = true;
    this._paused = false;
    this.flush();
  }
  private flush() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
  /** Block while paused; returns as soon as resumed or cancelled. */
  async wait(): Promise<void> {
    while (this._paused && !this._cancelled) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

const ZERO_JOB: JobSnapshot = {
  id: 0,
  status: "running",
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  bytes: 0,
  bytesPerSec: 0,
};

/**
 * Orchestrate a pipelined predownload: open a streaming download job, then parse
 * each story's manifest and immediately stream its (deduped, cached) asset URLs
 * to the job so indexing and downloading run CONCURRENTLY. Reports both phases'
 * progress via `onStatus` (two bars) and exposes one pause/cancel `onSession`.
 *
 * Also starts the Android keep-alive foreground service up-front (while the app
 * is in the foreground — Android 12+ forbids starting it from the background) and
 * stops it when done. Throws on the offline gate (detect with isOfflineError).
 */
export async function runPredownload(
  titles: string[],
  onStatus: (s: PredownloadStatus) => void,
  onSession: (s: PredownloadSession) => void
): Promise<{ cancelled: boolean; job: JobSnapshot | null }> {
  await invoke("set_download_keepalive", { active: true }).catch(() => {});

  const gate = new PauseGate();
  let manifestDone = 0;
  const manifestTotal = titles.length;
  let manifestActive = true;
  let paused = false;
  let dl: JobSnapshot = { ...ZERO_JOB };
  const emit = () =>
    onStatus({
      paused,
      manifestDone,
      manifestTotal,
      manifestActive,
      done: dl.done,
      total: dl.total,
      success: dl.success,
      failed: dl.failed,
      skipped: dl.skipped,
      bytesPerSec: dl.bytesPerSec,
    });

  try {
    const bundle = await loadBundle();
    // Open a streaming job (foreground → keep-alive start is allowed).
    const jobId = await invoke<number>("download_start", { urls: [] });

    onSession({
      pause: () => { paused = true; gate.pause(); invoke("download_pause", { jobId }); emit(); },
      resume: () => { paused = false; gate.resume(); invoke("download_resume", { jobId }); emit(); },
      cancel: () => { gate.cancel(); invoke("download_cancel", { jobId }); },
    });

    // Resolve when the job reaches a terminal status (driven by events + a poll backstop).
    let resolveDone: (s: JobSnapshot) => void = () => {};
    const done = new Promise<JobSnapshot>((res) => { resolveDone = res; });
    const isTerminal = (s: JobSnapshot) => s.status === "completed" || s.status === "cancelled";
    const unlisten = await listen<JobSnapshot>("download://progress", (e) => {
      if (e.payload.id !== jobId) return;
      dl = e.payload;
      if (e.payload.status === "paused") paused = true;
      emit();
      if (isTerminal(e.payload)) resolveDone(e.payload);
    });
    emit();

    // Index loop — capture each manifest and stream its URLs into the live job.
    let cancelled = false;
    for (let i = 0; i < titles.length; i++) {
      await gate.wait();
      if (gate.cancelled) { cancelled = true; break; }
      manifestDone = i;
      emit();
      try {
        const urls = await manifestForStory(bundle, titles[i]);
        await invoke("download_add", { jobId, urls });
      } catch (e) {
        if (isOfflineError(e)) { unlisten(); throw e; }
        console.warn("manifest failed for", titles[i], e);
      }
    }
    manifestDone = titles.length;
    manifestActive = false;
    emit();

    // No more URLs coming — let the queue drain and the job finish.
    await invoke("download_close", { jobId });
    const poll = setInterval(() => {
      invoke<JobSnapshot | null>("download_status", { jobId }).then((s) => {
        if (s && isTerminal(s)) resolveDone(s);
      });
    }, 400);
    const job = await done;
    clearInterval(poll);
    unlisten();
    return { cancelled: cancelled || job.status === "cancelled", job };
  } finally {
    await invoke("set_download_keepalive", { active: false }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Download settings (concurrency + bandwidth limit). The backend holds these in
// memory for the session; we mirror them to localStorage and re-apply on
// startup so they survive restarts.
// ---------------------------------------------------------------------------

export interface DownloadSettings {
  concurrency: number;
  rateLimitBps: number; // bytes/sec; 0 = unlimited
}

const SETTINGS_KEY = "prts-download-settings";

export async function getDownloadSettings(): Promise<DownloadSettings> {
  return await invoke<DownloadSettings>("download_settings_get");
}

export async function setDownloadSettings(s: DownloadSettings): Promise<void> {
  await invoke("download_settings_set", {
    concurrency: s.concurrency,
    rateLimitBps: s.rateLimitBps,
  });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** Re-apply persisted download settings to the backend (call once at startup). */
export async function applyPersistedDownloadSettings(): Promise<void> {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  try {
    const s = JSON.parse(raw) as DownloadSettings;
    await invoke("download_settings_set", {
      concurrency: s.concurrency,
      rateLimitBps: s.rateLimitBps,
    });
  } catch {
    /* ignore malformed persisted settings */
  }
}
