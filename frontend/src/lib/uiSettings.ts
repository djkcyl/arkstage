import { useSyncExternalStore } from "react";

// Small UI preferences kept in localStorage.
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
