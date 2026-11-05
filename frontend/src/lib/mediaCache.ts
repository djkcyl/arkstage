import { invoke } from "@tauri-apps/api/core";
import { PROXY_BASE } from "./proxy";

const pending = new Map<string, Promise<void>>();
export function resetPlaybackAssetRequests(): void { pending.clear(); }
export function originalAssetUrl(url: string): string | null {
  const original = url.startsWith(`${PROXY_BASE}/`) ? `https://${url.slice(PROXY_BASE.length + 1)}` : url;
  return /^https:\/\/(static|torappu|media)\.prts\.wiki\//.test(original) ? original : null;
}

export function ensurePlaybackAsset(url: string, refresh = false): Promise<void> {
  const original = originalAssetUrl(url);
  if (!original) return Promise.resolve();
  const key = `${refresh ? "refresh" : "asset"}:${original}`;
  let promise = pending.get(key);
  if (!promise) {
    promise = invoke<void>("ensure_playback_asset", { url: original, refresh });
    pending.set(key, promise);
    void promise.catch(() => { if (pending.get(key) === promise) pending.delete(key); });
  }
  return promise;
}
