import type { LogSnapshot } from "./playerTranscript";

const KEY = "prts-playback-resume-v1";
export interface PlaybackResume extends LogSnapshot { scriptHash: string; savedAt: number }
function records(): Record<string, PlaybackResume> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function persist(value: Record<string, PlaybackResume>) {
  try {
    const recent = Object.entries(value).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 80);
    // Keep resume data bounded even for unusually long stories.
    while (JSON.stringify(Object.fromEntries(recent)).length > 1_000_000) recent.pop();
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(recent)));
  } catch { /* Reading remains available if local storage is full. */ }
}
const line = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const selectionsValid = (value: unknown): value is LogSnapshot["selections"] => Array.isArray(value)
  && value.length <= 5000 && value.every(choice => line(choice?.decisionId)
    && Number.isSafeInteger(choice.optionIndex) && choice.optionIndex >= 0);
export function readPlaybackResume(title: string, scriptHash: string): PlaybackResume | null {
  const saved = records()[title];
  if (!saved || saved.scriptHash !== scriptHash || !line(saved.lineIndex) || !Number.isFinite(saved.savedAt)
    || !selectionsValid(saved.selections) || !Array.isArray(saved.readLines)
    || saved.readLines.length > 20_000 || !saved.readLines.every(line)
    || (saved.readCursor !== undefined && (!line(saved.readCursor) || saved.readCursor > saved.readLines.length))
    || (saved.choiceHistory !== undefined && (!Array.isArray(saved.choiceHistory) || saved.choiceHistory.length > 5000
      || !saved.choiceHistory.every((change, i, all) => Number.isSafeInteger(change?.index) && change.index >= 0
        && change.index < saved.readLines.length && (i === 0 || change.index > all[i - 1].index)
        && selectionsValid(change.selections))))) return null;
  return saved;
}
export function savePlaybackResume(title: string, scriptHash: string, position: LogSnapshot): void {
  if (!line(position.lineIndex)) return;
  const value = records();
  // Keep cursor/choice offsets aligned when a very long timeline is bounded.
  const offset = Math.max(0, Math.min(position.readCursor ?? position.readLines.length, position.readLines.length) - 20_000);
  const end = offset + 20_000;
  const before = position.choiceHistory?.filter(change => change.index <= offset).at(-1);
  const choiceHistory = position.choiceHistory && [
    ...(before ? [{ index: 0, selections: before.selections }] : []),
    ...position.choiceHistory.filter(change => change.index > offset && change.index < end).map(change => ({ ...change, index: change.index - offset })),
  ];
  value[title] = { ...position, readLines: position.readLines.slice(offset, end),
    readCursor: position.readCursor === undefined ? undefined : Math.max(1, position.readCursor - offset),
    choiceHistory, selections: position.selections.slice(-5000), scriptHash, savedAt: Date.now() };
  persist(value);
}
export function clearPlaybackResume(title: string): void {
  const value = records(); delete value[title]; persist(value);
}
