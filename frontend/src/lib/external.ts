import { invoke } from "@tauri-apps/api/core";

/** Open a URL in the system browser (Android intent / desktop default browser). */
export async function openExternal(url: string): Promise<void> {
  try {
    await invoke("open_external", { url });
  } catch {
    // Last resort (desktop dev / webview that allows it).
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      /* ignore */
    }
  }
}
