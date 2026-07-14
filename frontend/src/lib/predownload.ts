import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bootEngineInFrame, prewarmEngineDeps } from "./engineBoot";
import type { WidgetBundle } from "./engineBoot";
import { setManifestProgress } from "./keepalive";

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
  /** Keys that failed after retries (with last error), for diagnosing missing assets. */
  failedKeys: string[];
}

/** True when an error string came from the backend offline gate. */
export function isOfflineError(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).includes("PRTS_OFFLINE");
}

// One fresh-first request per app lifetime. The bundle contains PRTS's GLOBAL
// background/character/link databases; treating it as an eternal cache made every
// new event miss its art until the user manually cleared all cache. Network failure
// falls back to the last successful bundle so already-cached stories remain usable.
let bundlePromise: Promise<WidgetBundle> | null = null;

/** Load the shared widget bundle (engine DOM + scripts + global databases). */
export function loadBundle(): Promise<WidgetBundle> {
  if (!bundlePromise) bundlePromise = refreshBundle();
  return bundlePromise;
}

async function refreshBundle(): Promise<WidgetBundle> {
  let cached: WidgetBundle | null = null;
  try {
    const raw = await invoke<string | null>("load_from_cache", { key: "widget-bundle-v2" });
    if (raw) cached = JSON.parse(raw) as WidgetBundle;
  } catch {
    // Continue with the live request.
  }
  try {
    const fresh = await invoke<WidgetBundle>("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
    await invoke("save_to_cache", {
      key: "widget-bundle-v2",
      data: JSON.stringify(fresh),
    }).catch(() => {});
    return fresh;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
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
 * How many story manifests to capture concurrently. Each capture boots the engine
 * in its own hidden iframe (independent realms), so several can run at once; this
 * overlaps the (network-bound) script fetches with the (CPU-bound) engine parsing
 * and is the main speed-up for the indexing phase. Kept modest so several heavy
 * engine iframes don't exhaust memory on low-end phones.
 */
const MANIFEST_CONCURRENCY = 4;

/**
 * How many passes to retry stories whose manifest capture failed before giving up.
 * Failures are usually transient (the WebView renderer was throttled/frozen while
 * backgrounded); retrying keeps the job from closing early with missing assets.
 * Bounded so a genuinely broken story can't loop forever.
 */
const MANIFEST_INDEX_ROUNDS = 4;

// Screen Wake Lock — keep the screen on (so the WebView renderer stays active and
// the indexing phase keeps running) while the user has the app open and sets the
// phone down. The lock auto-releases when the page is hidden, so we re-acquire on
// visibility. Best-effort: unsupported/denied just no-ops. Doesn't help once the
// app is fully backgrounded (that's what PHASE-1 Rust cached-feeding is for).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let screenWakeLock: any = null;
async function acquireScreenWake(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wl = (navigator as any).wakeLock;
    if (wl && !screenWakeLock) screenWakeLock = await wl.request("screen");
  } catch {
    screenWakeLock = null;
  }
}
function releaseScreenWake(): void {
  try {
    void screenWakeLock?.release();
  } catch {
    /* ignore */
  }
  screenWakeLock = null;
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
  failedKeys: [],
};

/**
 * Orchestrate a pipelined predownload: open a streaming download job, then parse
 * each story's manifest and immediately stream its (deduped, cached) asset URLs
 * to the job so indexing and downloading run CONCURRENTLY. Reports both phases'
 * progress via `onStatus` (two bars) and exposes one pause/cancel `onSession`.
 *
 * Brings up the Android keep-alive foreground service with "downloading" text + a
 * progress bar while it runs (via setDownloadProgress), and clears it (`null`) when
 * done — which tears the service/notification down unless a story is being read.
 * Throws on the offline gate (detect with isOfflineError).
 */
export async function runPredownload(
  titles: string[],
  onStatus: (s: PredownloadStatus) => void,
  onSession: (s: PredownloadSession) => void
): Promise<{ cancelled: boolean; job: JobSnapshot | null }> {
  // Tell the native keep-alive about indexing right away (download counts come
  // from the Rust engine; the FGS itself is started by the download_start command).
  setManifestProgress(0, titles.length, true);

  const gate = new PauseGate();
  let manifestDone = 0;
  const manifestTotal = titles.length;
  let manifestActive = true;
  let paused = false;
  let dl: JobSnapshot = { ...ZERO_JOB };
  const emit = () => {
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
    // Mirror only the indexing counts to the native keep-alive; the download
    // numbers + the notification itself are driven by the Rust engine.
    setManifestProgress(manifestDone, manifestTotal, manifestActive);
  };

  // Keep the screen awake for the duration (re-acquire when the app becomes
  // visible again, since the lock drops while hidden).
  const onVisible = () => { if (document.visibilityState === "visible") void acquireScreenWake(); };
  document.addEventListener("visibilitychange", onVisible);
  await acquireScreenWake();

  try {
    const bundle = await loadBundle();
    // Cache the engine deps once up-front (via Rust) so the parallel iframe boots
    // below all load jQuery/PreloadJS/toolbox from disk instead of the network.
    await prewarmEngineDeps();
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

    let cancelled = false;
    let offlineErr: unknown = null;

    // PHASE 1 (Rust, background-proof): feed every ALREADY-cached manifest straight
    // from the cache files into the job — no WebView involved, so these keep
    // downloading even when the app is fully backgrounded (Home/screen-off), which
    // is when aggressive ROMs freeze the WebView renderer. Returns the titles that
    // still need WebView engine indexing.
    let pending: string[];
    try {
      pending = await invoke<string[]>("download_feed_cached", { jobId, titles });
    } catch {
      pending = [...titles];
    }
    const cachedCount = titles.length - pending.length;
    let indexed = 0; // uncached stories newly indexed this run
    manifestDone = cachedCount;
    emit();

    // PHASE 2 (WebView): index the remaining uncached stories. Booting the engine
    // per story (hidden iframe) MUST run in the foreground WebView — the screen wake
    // lock above keeps it alive while the phone is set down. A POOL runs
    // concurrently; failures are RETRIED (not dropped) so a momentary background
    // throttle doesn't close the job early with missing assets — it resumes on
    // return to the foreground.
    const indexOne = async (title: string): Promise<boolean> => {
      try {
        const urls = (await manifestForStory(bundle, title))
          // Only real http(s) assets are downloadable; drop data:/blob:/relative
          // URLs the engine emits so they never inflate the total or look failed.
          .filter((u) => /^https?:\/\//i.test(u));
        await invoke("download_add", { jobId, urls });
        indexed++;
        manifestDone = cachedCount + indexed;
        emit();
        return true;
      } catch (e) {
        if (isOfflineError(e)) { offlineErr = e; return false; }
        console.warn("manifest failed for", title, e);
        return false;
      }
    };

    // One concurrent pass over `items` (titles); returns the ones that failed.
    const runPass = async (items: string[]): Promise<string[]> => {
      const failed: string[] = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          await gate.wait();
          if (gate.cancelled) { cancelled = true; return; }
          if (offlineErr) return;
          const k = next++;
          if (k >= items.length) return;
          const ok = await indexOne(items[k]);
          if (!ok && !gate.cancelled && !offlineErr) failed.push(items[k]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MANIFEST_CONCURRENCY, items.length) }, worker)
      );
      return failed;
    };

    for (let round = 0; round < MANIFEST_INDEX_ROUNDS; round++) {
      if (!pending.length) break;
      pending = await runPass(pending);
      if (!pending.length || gate.cancelled || offlineErr) break;
      // Backoff before retrying. If the app is backgrounded (renderer throttled),
      // the awaited work below simply doesn't progress until it's foreground again.
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (offlineErr) { unlisten(); throw offlineErr; }
    if (pending.length) {
      console.warn(
        `predownload: ${pending.length}/${titles.length} stories could not be indexed after ${MANIFEST_INDEX_ROUNDS} rounds`
      );
    }
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
    document.removeEventListener("visibilitychange", onVisible);
    releaseScreenWake();
    // Indexing is over; clear its counts. The engine clears the download state on
    // the job's terminal snapshot, which drops the service to "reading" or stops it.
    setManifestProgress(0, 0, false);
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
