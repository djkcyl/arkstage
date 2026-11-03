export interface TranscriptEntry {
  line: number;
  speaker: string;
  text: string;
}

// Keep script line numbers aligned with the engine's displayed-line index.
// Render as React text, never as HTML supplied by a downloaded script.
function plainText(value: string): string {
  return value.replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:b|i|u|color|size)(?:=[^>]*)?>/gi, "")
    .replace(/\\n/g, "\n").trim();
}

export function buildTranscript(script: string, lastLine?: number | null): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  const lines = script.split("\n");
  const end = lastLine === undefined ? lines.length : Math.min(lines.length, (lastLine ?? -1) + 1);
  for (let index = 0; index < end; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith("//")) continue;
    const dialogue = line.match(/^\[name\s*=\s*(["'])(.*?)\1\]\s*(.*)$/i);
    if (!dialogue && line.startsWith("[")) continue;
    const text = plainText(dialogue ? dialogue[3] : line);
    if (text) result.push({ line: index, speaker: dialogue ? plainText(dialogue[2]) : "", text });
  }
  return result;
}
