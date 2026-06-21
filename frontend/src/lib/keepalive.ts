import { invoke } from "@tauri-apps/api/core";

/**
 * Android keep-alive — thin frontend bridge.
 *
 * The foreground service + notification are now driven mostly by the NATIVE Rust
 * download engine (so progress keeps updating, and the service stays alive, even
 * when the WebView renderer is frozen in the background — which aggressive ROMs
 * like ColorOS do). The frontend only reports the two things the engine can't see:
 *
 *   - playback state ("正在走过漫漫时空…")  → setReading
 *   - indexing/manifest counts             → setManifestProgress
 *
 * Download counts + the service lifecycle (start on download begin, stop when idle)
 * are handled in Rust. All of these are no-ops on desktop.
 */

/** Toggle the "reading a story" (playback) notification state. */
export function setReading(value: boolean): void {
  invoke("keepalive_set_reading", { reading: value }).catch(() => {});
}

/**
 * Report indexing progress so it can be folded into the download notification
 * ("索引 X/Y · 下载 A/B"). `active=false` once indexing has finished (or there's no
 * download running).
 */
export function setManifestProgress(done: number, total: number, active: boolean): void {
  invoke("keepalive_set_manifest", { done, total, active }).catch(() => {});
}

/** Establish a clean baseline at startup (nothing playing). */
export function startKeepalive(): void {
  setReading(false);
}
