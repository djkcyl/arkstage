import { useSyncExternalStore } from "react";

// Small UI preferences kept in localStorage. "hidePlayerBack" hides ONLY the
// reader's on-screen back button (the other pages keep theirs); users who use the
// system back gesture can declutter the immersive reader.

const HIDE_PLAYER_BACK_KEY = "prts-hide-player-back";
const LOG_FONT_SIZE_KEY = "prts-log-font-size";
export const LOG_FONT_MIN = 12;
export const LOG_FONT_MAX = 32;
export const LOG_FONT_DEFAULT = 18;
const listeners = new Set<() => void>();

export function getLogFontSize(): number {
  const saved = Number(localStorage.getItem(LOG_FONT_SIZE_KEY));
  return Number.isFinite(saved) && saved >= LOG_FONT_MIN && saved <= LOG_FONT_MAX
    ? Math.round(saved) : LOG_FONT_DEFAULT;
}

export function setLogFontSize(value: number): void {
  const size = Number.isFinite(value)
    ? Math.max(LOG_FONT_MIN, Math.min(LOG_FONT_MAX, Math.round(value))) : LOG_FONT_DEFAULT;
  localStorage.setItem(LOG_FONT_SIZE_KEY, String(size));
  listeners.forEach((listener) => listener());
}

export function useLogFontSize(): number {
  return useSyncExternalStore(subscribe, getLogFontSize);
}

export function isHidePlayerBack(): boolean {
  return localStorage.getItem(HIDE_PLAYER_BACK_KEY) === "1";
}

export function setHidePlayerBack(value: boolean): void {
  if (value) localStorage.setItem(HIDE_PLAYER_BACK_KEY, "1");
  else localStorage.removeItem(HIDE_PLAYER_BACK_KEY);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: true when the reader's on-screen back button should be hidden. */
export function useHidePlayerBack(): boolean {
  return useSyncExternalStore(subscribe, isHidePlayerBack);
}
