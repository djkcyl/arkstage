import { platform as osPlatform } from "@tauri-apps/plugin-os";

export type Platform = "windows" | "macos" | "linux" | "android" | "ios" | "unknown";

let cached: Platform | null = null;

/**
 * Current platform. Prefers @tauri-apps/plugin-os `platform()` (synchronous in
 * v2); falls back to userAgent sniffing if the plugin isn't ready at the moment
 * of a very-early module-load call. Cached after first resolution.
 */
export function getPlatform(): Platform {
  if (cached) return cached;
  let p: Platform = "unknown";
  try {
    const raw = osPlatform();
    if (
      raw === "windows" ||
      raw === "macos" ||
      raw === "linux" ||
      raw === "android" ||
      raw === "ios"
    ) {
      p = raw;
    }
  } catch {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (ua.includes("Windows")) p = "windows";
    else if (ua.includes("Android")) p = "android";
    else if (ua.includes("Mac")) p = "macos";
    else if (ua) p = "linux";
  }
  cached = p;
  return p;
}

export const isAndroid = (): boolean => getPlatform() === "android";
export const isWindows = (): boolean => getPlatform() === "windows";

/**
 * Platforms whose WebView is Chromium-based and serves Tauri custom schemes at
 * `http://<scheme>.localhost/` instead of `<scheme>://localhost/`: Windows
 * (WebView2) and Android (system WebView).
 */
export const usesHttpLocalhostScheme = (): boolean => isWindows() || isAndroid();
