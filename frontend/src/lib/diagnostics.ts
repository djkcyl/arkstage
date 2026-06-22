import { getVersion } from "@tauri-apps/api/app";
import { version as osVersion } from "@tauri-apps/plugin-os";
import { invoke } from "@tauri-apps/api/core";
import { getPlatform } from "./platform";

/**
 * Gather a one-shot environment snapshot for bug reports — app version, platform,
 * the WebView (Chrome) version (from the UA), screen/orientation, online policy.
 * The WebView version is the line most useful for player/engine issues.
 */
export async function collectEnvInfo(): Promise<string> {
  let appVer = "?";
  try {
    appVer = await getVersion();
  } catch {
    /* not in tauri */
  }
  let os = "?";
  try {
    os = osVersion();
  } catch {
    /* ignore */
  }
  let online = "?";
  try {
    online = String(await invoke<boolean>("get_allow_online"));
  } catch {
    /* ignore */
  }
  const ua = navigator.userAgent;
  const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "未知";
  const ori =
    (screen.orientation && screen.orientation.type) ||
    (window.innerWidth >= window.innerHeight ? "landscape" : "portrait");
  return [
    "===== Arkstage 环境信息 =====",
    `应用版本: ${appVer}`,
    `平台: ${getPlatform()} ${os}`,
    `WebView (Chrome 内核): ${chrome}`,
    `视口: ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x (${ori})`,
    `联网: ${online}`,
    `时间: ${new Date().toISOString()}`,
    `UA: ${ua}`,
  ].join("\n");
}

/** Copy text to the clipboard (Clipboard API, with a textarea fallback). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
}
