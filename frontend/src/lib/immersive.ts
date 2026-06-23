import { invoke } from "@tauri-apps/api/core";

// Hide the Android system bars (status + navigation) for the player only, so the
// fullscreen reader isn't occluded. Every other screen keeps the bars visible.
// No-op off Android (the backend command just returns Ok on desktop).
export function setImmersive(on: boolean): void {
  invoke("set_immersive", { enabled: on }).catch(() => {});
}
