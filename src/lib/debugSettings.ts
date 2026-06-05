/**
 * Controls whether the on-screen debug console (DebugConsole) is visible.
 *
 * Default is build-time: CI/release workflows and the build scripts set
 * VITE_DEBUG_DEFAULT=true so those artifacts ship with diagnostics on; an
 * ordinary `npm run tauri:build` leaves it off. The user can override the default
 * either way from Settings; the choice is persisted in localStorage and survives
 * across launches. "default" means "follow the build-time default".
 */

const STORAGE_KEY = "prts-debug-console";
const BUILD_DEFAULT = import.meta.env.VITE_DEBUG_DEFAULT === "true";

export type DebugPref = "on" | "off" | "default";

const listeners = new Set<() => void>();

/** Resolved visibility: explicit user choice if set, otherwise the build default. */
export function isDebugConsoleEnabled(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "on") return true;
  if (stored === "off") return false;
  return BUILD_DEFAULT;
}

/** The user's stored preference, or "default" when none has been set. */
export function getDebugPref(): DebugPref {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "on" || stored === "off" ? stored : "default";
}

/** Whether builds default this on (shown next to the "default" choice in Settings). */
export function debugBuildDefault(): boolean {
  return BUILD_DEFAULT;
}

export function setDebugPref(pref: DebugPref): void {
  if (pref === "default") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, pref);
  listeners.forEach((l) => l());
}

export function subscribeDebugSetting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
