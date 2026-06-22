// Tracks which stories the user has opened in the player ("read"), so the
// bookshelf can distinguish read vs unread chapters. Persisted in localStorage
// (independent of the download cache — a story can be read without being cached,
// or cached without being read).

const KEY = "arkstage-read-stories";

export function getReadStories(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Mark one story (by page_title) as read; persists immediately. */
export function markRead(pageTitle: string): void {
  try {
    const s = getReadStories();
    if (s.has(pageTitle)) return;
    s.add(pageTitle);
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* storage unavailable — read state is best-effort */
  }
}
