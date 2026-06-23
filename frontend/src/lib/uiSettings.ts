import { useSyncExternalStore } from "react";

// Small UI preferences kept in localStorage. "hidePlayerBack" hides ONLY the
// reader's on-screen back button (the other pages keep theirs); users who use the
// system back gesture can declutter the immersive reader.

const HIDE_PLAYER_BACK_KEY = "prts-hide-player-back";
const listeners = new Set<() => void>();

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
