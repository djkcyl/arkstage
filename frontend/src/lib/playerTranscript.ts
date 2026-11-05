/** Source positions and choices come from the same runtime that draws dialogue. */
export interface LogPosition {
  lineIndex: number | null;
  selections: { decisionId: number; optionIndex: number }[];
}

export interface LogSnapshot extends LogPosition {
  readLines: number[];
  /** One-based position within the visited timeline, independent of source order. */
  readCursor?: number;
  /** Sparse choice snapshots, captured when a visited line's branch changes. */
  choiceHistory?: { index: number; selections: LogPosition["selections"] }[];
}

export interface NativeLogView {
  update(position: LogSnapshot): void;
  dispose(): void;
}

/** Keep execution order, rather than treating every source line before the
 * cursor as read. Branches and jumps may skip or revisit physical lines. */
export function createReadLogHistory() {
  let lines: number[] = [];
  let choices: LogPosition["selections"][] = [];
  let cursor = -1;
  const copy = (value: LogPosition["selections"]) => value.map(choice => ({ ...choice }));
  const same = (a: LogPosition["selections"], b: LogPosition["selections"]) => a.length === b.length
    && a.every((choice, i) => choice.decisionId === b[i].decisionId && choice.optionIndex === b[i].optionIndex);
  const history = () => choices.flatMap((value, index) => index === 0 || value !== choices[index - 1]
    ? [{ index, selections: copy(value) }] : []);
  return {
    record(line: number | null, selections: LogPosition["selections"] = []) {
      if (line == null || lines[cursor] === line) return;
      // Walking the same already-read path moves the marker without duplicating
      // its text. A different branch becomes a new actual visit in the timeline.
      if (lines[cursor + 1] === line && same(choices[cursor + 1], selections)) { cursor++; return; }
      const previous = choices.at(-1);
      choices.push(previous && same(previous, selections) ? previous : copy(selections));
      lines.push(line); cursor = lines.length - 1;
    },
    snapshot() { return [...lines]; },
    cursor() { return cursor + 1; },
    choices: history,
    target(index: number): LogSnapshot | null {
      if (!Number.isInteger(index) || index < 0 || index >= lines.length) return null;
      return { lineIndex: lines[index], selections: copy(choices[index]), readLines: [...lines],
        readCursor: index + 1, choiceHistory: history() };
    },
    reset() { lines = []; choices = []; cursor = -1; },
    restore(saved: LogSnapshot) {
      lines = [...saved.readLines];
      cursor = Math.min(lines.length, Math.max(0, saved.readCursor ?? lines.length)) - 1;
      const changes = new Map(saved.choiceHistory?.map(change => [change.index, change.selections]));
      let current = copy(saved.selections);
      choices = lines.map((_, index) => {
        const changed = changes.get(index);
        if (changed) current = copy(changed);
        return current;
      });
    },
  };
}

interface LogEntry {
  lineIndex: number;
  speaker: string;
  source: string;
  spans: { text: string }[];
}
interface LogBlock {
  kind: string;
  audience: number;
  entries?: LogEntry[];
  blocks?: LogBlock[];
}
interface LogDocument {
  blocks: LogBlock[];
  conditions: { evaluatePartial(audience: number, choices: Map<number, number>): boolean | null };
}

/** The wiki merges multiline runs at their final source line. While a run is
 * still on screen, use its native prefix entry, keeping the full document's
 * condition store and layout. Never guess a nearby line or show later fragments
 * as the current dialogue. This function is also embedded in the engine realm. */
export function logDocumentAt(document: LogDocument, position: LogPosition, buildPrefix: () => LogDocument, keepCompleteText = false): LogDocument {
  const current = position.lineIndex;
  if (current == null) return document;
  const choices = new Map(position.selections.map(choice => [choice.decisionId, choice.optionIndex]));
  const entries = (doc: LogDocument): LogEntry[] => {
    const visit = (blocks: LogBlock[]): LogEntry[] => blocks.flatMap(block => {
      if (doc.conditions.evaluatePartial(block.audience, choices) === false) return [];
      return block.kind === "lines" ? block.entries ?? [] : visit(block.blocks ?? []);
    });
    return visit(doc.blocks);
  };
  const full = entries(document);
  if (full.some(entry => entry.lineIndex === current)) return document;
  const prefix = entries(buildPrefix()).filter(entry => entry.lineIndex === current);
  const replacements = new Map<LogEntry, LogEntry>();
  const text = (entry: LogEntry) => entry.spans.map(span => span.text).join("");
  for (const partial of prefix) {
    const target = full.filter(entry => entry.lineIndex > current && entry.source === partial.source
      && entry.speaker === partial.speaker && text(entry).startsWith(text(partial)))
      .sort((a, b) => a.lineIndex - b.lineIndex)[0];
    if (target) replacements.set(target, keepCompleteText ? { ...target, lineIndex: current } : partial);
  }
  if (!replacements.size) return document;
  const replace = (blocks: LogBlock[]): LogBlock[] => blocks.map(block => block.kind === "lines"
    ? { ...block, entries: block.entries?.map(entry => replacements.get(entry) ?? entry) }
    : block.blocks ? { ...block, blocks: replace(block.blocks) } : block);
  return { ...document, blocks: replace(document.blocks) };
}

// The native runtime clears its visible line during non-text scenes and at the
// end. Keep the last displayed source line until an explicit replay reset.
export function createLogPosition() {
  let lastLine: number | null = null;
  let signature = "";
  return {
    read(position: LogPosition): LogPosition {
      if (position.lineIndex != null) lastLine = position.lineIndex;
      return { lineIndex: lastLine, selections: position.selections.map(selection => ({ ...selection })) };
    },
    changed(position: LogPosition): boolean {
      const next = JSON.stringify(position);
      if (next === signature) return false;
      signature = next;
      return true;
    },
    reset() { lastLine = null; signature = ""; },
  };
}
