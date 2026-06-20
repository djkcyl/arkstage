import { invoke } from "@tauri-apps/api/core";

/**
 * Android keep-alive notification — content driver.
 *
 * The foreground service itself is started natively at launch (MainActivity); the
 * baseline persistent notification therefore exists regardless of this module. We
 * only refine its text + progress as the app's state changes:
 *
 *   - downloading/indexing → "正在释放神经递质…" (with a progress bar)
 *   - reading a story       → "正在走过漫漫时空…"
 *   - idle                  → "保持后台运行中"
 *
 * Download state takes precedence over reading (its progress is the more useful
 * thing to surface). No-op on desktop — `update_keepalive` is a no-op off Android.
 */

const TITLE = "方舟剧场";

/** Both phases of a predownload — the bar tracks whichever is further behind. */
interface DownloadState {
  manifestDone: number;
  manifestTotal: number;
  manifestActive: boolean; // false once indexing has fully finished
  done: number; // downloaded assets
  total: number; // known assets so far (0 until the first is queued)
}

let reading = false;
let download: DownloadState | null = null;
let lastKey = "";

const frac = (done: number, total: number): number =>
  total > 0 ? Math.min(done / total, 1) : 0;

function push(): void {
  let text: string;
  let progress = -1;
  let max = 0;

  if (download) {
    text = "正在释放神经递质…";
    // Index + download run concurrently; surface the *slower* of the two so the
    // bar never overstates real progress (download lags indexing, usually).
    const idx = download.manifestActive
      ? frac(download.manifestDone, download.manifestTotal)
      : 1;
    const dl = frac(download.done, download.total);
    progress = Math.round(Math.min(idx, dl) * 100);
    max = 100;
  } else if (reading) {
    text = "正在走过漫漫时空…";
  } else {
    text = "保持后台运行中";
  }

  // Throttle: re-posting the foreground notification on every progress tick is
  // wasteful, so skip when nothing the user can see has changed (text + percent).
  const key = `${text}|${max > 0 ? progress : -1}`;
  if (key === lastKey) return;
  lastKey = key;

  invoke("update_keepalive", {
    active: true,
    title: TITLE,
    text,
    progress,
    max,
    indeterminate: false,
  }).catch(() => {});
}

/** Push the current (idle) notification — call once at app startup. */
export function startKeepalive(): void {
  push();
}

/** Toggle the "reading a story" state. */
export function setReading(value: boolean): void {
  reading = value;
  push();
}

/** Report download + indexing progress, or `null` once it finishes. */
export function setDownloadProgress(state: DownloadState | null): void {
  download = state;
  push();
}

export type { DownloadState };
