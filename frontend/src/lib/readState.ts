// Tracks stories confirmed complete by the player, so the
// bookshelf can distinguish completed vs unfinished chapters. Persisted in localStorage
// (independent of the download cache — a story can be read without being cached,
// or cached without being read).

// Keep the old timed markers intact, but never treat them as completion evidence.
const KEY = "arkstage-completed-stories-v2";
const CHANGE_EVENT = "arkstage-reading-state-changed";
function notify() { if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT)); }
export function subscribeReadState(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener("storage", listener); };
}

export function getReadStories(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const values: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

/** Record confirmed playback completion; persists immediately. */
export function markRead(pageTitle: string): void {
  try {
    const s = getReadStories();
    if (s.has(pageTitle)) return;
    s.add(pageTitle);
    localStorage.setItem(KEY, JSON.stringify([...s]));
    notify();
  } catch {
    /* storage unavailable — read state is best-effort */
  }
}

// "Last watched" — the most recently opened story (by page_title), so the shelf
// and chapter list can point the user back to where they left off ("上次观看").
const LAST_KEY = "arkstage-last-watched";

export function getLastWatched(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastWatched(pageTitle: string): void {
  try {
    localStorage.setItem(LAST_KEY, pageTitle);
    notify();
  } catch {
    /* best-effort */
  }
}
