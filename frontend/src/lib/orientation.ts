import { invoke } from "@tauri-apps/api/core";

// Runtime screen-orientation control. Only the player forces landscape; every
// other screen uses the device's free/sensor orientation. No-op off Android
// (the backend command just returns Ok on desktop).
export function setLandscape(on: boolean): void {
  invoke("set_orientation", { landscape: on }).catch(() => {});
}
