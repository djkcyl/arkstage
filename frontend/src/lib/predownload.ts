import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bootEngineInFrame } from "./engineBoot";
import type { WidgetBundle } from "./engineBoot";

export type PredownloadPhase = "manifest" | "download";

/** Unified status across both phases (manifest parsing + media download), so the
 *  UI shows one continuous progress with a single pause/cancel control. */
export interface PredownloadStatus {
  phase: PredownloadPhase;
  paused: boolean;
  done: number;
  total: number;
  /** manifest phase: the story being parsed. */
  label?: string;
  /** download phase counters + speed. */
  success?: number;
  failed?: number;
  skipped?: number;
  bytesPerSec?: number;
}

/** One control surface that drives whichever phase is currently active. */
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

/** Controls for an in-flight download job. */
export interface DownloadHandle {
  jobId: number;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
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

/**
 * Orchestrate a full predownload: phase 1 parses+caches each story's manifest
 * (pausable/cancellable, breakpoint-resumable via the cache), phase 2 runs the
 * managed media download. Both report through one `onStatus` stream and obey one
 * `onSession` control. Throws on the offline gate (detect with isOfflineError).
 */
export async function runPredownload(
  titles: string[],
  onStatus: (s: PredownloadStatus) => void,
  onSession: (s: PredownloadSession) => void
): Promise<{ cancelled: boolean; manifestCount: number; job: JobSnapshot | null }> {
  const gate = new PauseGate();
  let phase: PredownloadPhase = "manifest";
  let handle: DownloadHandle | null = null;
  let current: PredownloadStatus = { phase: "manifest", paused: false, done: 0, total: titles.length };
  const emit = (patch: Partial<PredownloadStatus>) => {
    current = { ...current, ...patch };
    onStatus(current);
  };

  // Route the single control surface to whichever phase is active.
  onSession({
    pause: () => {
      if (phase === "manifest") {
        gate.pause();
        emit({ paused: true });
      } else {
        handle?.pause();
      }
    },
    resume: () => {
      if (phase === "manifest") {
        gate.resume();
        emit({ paused: false });
      } else {
        handle?.resume();
      }
    },
    cancel: () => {
      gate.cancel();
      handle?.cancel();
    },
  });

  // Phase 1 — manifest (engine-driven, cached).
  const bundle = await loadBundle();
  const union = new Set<string>();
  for (let i = 0; i < titles.length; i++) {
    await gate.wait();
    if (gate.cancelled) return { cancelled: true, manifestCount: union.size, job: null };
    emit({ phase: "manifest", done: i, total: titles.length, label: titles[i] });
    try {
      const urls = await manifestForStory(bundle, titles[i]);
      urls.forEach((u) => union.add(u));
    } catch (e) {
      if (isOfflineError(e)) throw e; // offline → abort; caller shows the hint
      console.warn("manifest failed for", titles[i], e);
    }
  }
  emit({ done: titles.length, label: "" });

  // Phase 2 — managed media download.
  if (gate.cancelled) return { cancelled: true, manifestCount: union.size, job: null };
  phase = "download";
  const job = await runDownloadJob(
    Array.from(union),
    (snap) =>
      emit({
        phase: "download",
        paused: snap.status === "paused",
        done: snap.done,
        total: snap.total,
        success: snap.success,
        failed: snap.failed,
        skipped: snap.skipped,
        bytesPerSec: snap.bytesPerSec,
        label: "",
      }),
    (h) => {
      handle = h;
    }
  );
  return { cancelled: job.status === "cancelled", manifestCount: union.size, job };
}

/**
 * Start a managed download job over `urls` and resolve when it finishes
 * (completed or cancelled). Live snapshots arrive via `onSnapshot`; the job's
 * control handle (pause/resume/cancel) is delivered via `onHandle`. Throws if the
 * backend refuses to start (e.g. offline) — detect with {@link isOfflineError}.
 */
export async function runDownloadJob(
  urls: string[],
  onSnapshot: (s: JobSnapshot) => void,
  onHandle: (h: DownloadHandle) => void
): Promise<JobSnapshot> {
  const jobId = await invoke<number>("download_start", { urls });
  onHandle({
    jobId,
    pause: () => invoke("download_pause", { jobId }),
    resume: () => invoke("download_resume", { jobId }),
    cancel: () => invoke("download_cancel", { jobId }),
  });

  return await new Promise<JobSnapshot>((resolve) => {
    let unlisten = () => {};
    let settled = false;
    const finish = (s: JobSnapshot) => {
      if (settled) return;
      settled = true;
      unlisten();
      resolve(s);
    };
    const isTerminal = (s: JobSnapshot) => s.status === "completed" || s.status === "cancelled";
    listen<JobSnapshot>("download://progress", (e) => {
      if (e.payload.id !== jobId) return;
      onSnapshot(e.payload);
      if (isTerminal(e.payload)) finish(e.payload);
    }).then((un) => {
      unlisten = un;
      // Race guard: a tiny / all-skipped job can finish before the listener
      // attaches, so poll its status once after subscribing.
      invoke<JobSnapshot | null>("download_status", { jobId }).then((s) => {
        if (s) {
          onSnapshot(s);
          if (isTerminal(s)) finish(s);
        }
      });
    });
  });
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
