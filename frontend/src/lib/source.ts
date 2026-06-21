import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Asset source selection. The backend holds the active source + its tuning in
// memory; jsDelivr (mirror) is the default fast path and the official prts.wiki
// source is the per-file fallback. The prts limits are fixed server-side and
// surfaced here read-only.
// ---------------------------------------------------------------------------

export type SourceKind = "jsd" | "prts";

export interface SourceConfig {
  kind: SourceKind;
  jsdRepo: string;
  jsdRef: string;
  jsdConcurrency: number;
  prtsMaxConcurrency: number; // fixed (server clamps to 2)
  prtsRateLimitBps: number; // fixed (server clamps to 5 MB/s)
}

export async function getSource(): Promise<SourceConfig> {
  return await invoke<SourceConfig>("source_get");
}

export async function setSource(p: {
  kind?: SourceKind;
  jsdRepo?: string;
  jsdRef?: string;
  jsdConcurrency?: number;
}): Promise<void> {
  await invoke("source_set", p);
}
