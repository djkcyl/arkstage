/* eslint-disable react-refresh/only-export-components */
import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { proxyUrl } from "./proxy";

const RESOURCE_ROOT = "https://cdn.jsdelivr.net/gh/djkcyl/arkstage@resources";
const METADATA_URL = `${RESOURCE_ROOT}/metadata.json`;
const CACHE_KEY = "bookshelf-metadata";

export interface RemoteArt {
  path: string;
  width: number;
  height: number;
}

export interface ScenarioLinkOverride {
  pos: { x: number; y: number };
  size: { x: number; y: number };
}

export interface BookshelfMetadata {
  schemaVersion: 1;
  version: string;
  storylines: [string, string[]][];
  covers: Record<string, RemoteArt>;
  banners: Record<string, RemoteArt>;
  scenarioLinks: Record<string, ScenarioLinkOverride>;
}

interface ContextValue {
  metadata: BookshelfMetadata | null;
  resolveArt: (kind: "covers" | "banners", key: string) => Promise<ResolvedArt | null>;
}

export interface ResolvedArt extends RemoteArt {
  url: string;
}

const Context = createContext<ContextValue | null>(null);
let currentMetadata: BookshelfMetadata | null = null;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseArtMap(value: unknown, kind: "covers" | "banners"): Record<string, RemoteArt> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, RemoteArt> = {};
  const pathPattern = new RegExp(`^${kind}/[0-9a-f]{20}\\.webp$`);
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const art = raw as Record<string, unknown>;
    if (
      typeof art.path !== "string" ||
      !pathPattern.test(art.path) ||
      !isNumber(art.width) ||
      !isNumber(art.height) ||
      art.width <= 0 ||
      art.height <= 0 ||
      art.width > 8192 ||
      art.height > 8192
    ) {
      return null;
    }
    result[key] = { path: art.path, width: art.width, height: art.height };
  }
  return result;
}

/** Validate untrusted runtime metadata before it can affect paths or layout. */
export function parseBookshelfMetadata(value: unknown): BookshelfMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.version !== "string" || !/^[0-9a-f]{20}$/.test(raw.version)) {
    return null;
  }
  if (!Array.isArray(raw.storylines)) return null;
  const storylines: [string, string[]][] = [];
  for (const entry of raw.storylines) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !Array.isArray(entry[1]) ||
      !entry[1].every((name) => typeof name === "string")
    ) {
      return null;
    }
    storylines.push([entry[0], [...entry[1]]]);
  }
  const covers = parseArtMap(raw.covers, "covers");
  const banners = parseArtMap(raw.banners, "banners");
  if (!covers || !banners) return null;

  const scenarioLinks: Record<string, ScenarioLinkOverride> = {};
  if (!raw.scenarioLinks || typeof raw.scenarioLinks !== "object" || Array.isArray(raw.scenarioLinks)) {
    return null;
  }
  for (const [key, value] of Object.entries(raw.scenarioLinks)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const link = value as Record<string, unknown>;
    const pos = link.pos as Record<string, unknown> | undefined;
    const size = link.size as Record<string, unknown> | undefined;
    if (
      !pos ||
      !size ||
      !isNumber(pos.x) ||
      !isNumber(pos.y) ||
      !isNumber(size.x) ||
      !isNumber(size.y) ||
      size.x <= 0 ||
      size.y <= 0
    ) {
      return null;
    }
    scenarioLinks[key.toLowerCase()] = {
      pos: { x: pos.x, y: pos.y },
      size: { x: size.x, y: size.y },
    };
  }
  return { schemaVersion: 1, version: raw.version, storylines, covers, banners, scenarioLinks };
}

async function loadCached(): Promise<BookshelfMetadata | null> {
  try {
    const cached = await invoke<string | null>("load_from_cache", { key: CACHE_KEY });
    return cached ? parseBookshelfMetadata(JSON.parse(cached)) : null;
  } catch {
    return null;
  }
}

async function refreshRemote(): Promise<BookshelfMetadata | null> {
  const response = await fetch(METADATA_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`bookshelf metadata HTTP ${response.status}`);
  const parsed = parseBookshelfMetadata(await response.json());
  if (!parsed) throw new Error("invalid bookshelf metadata");
  await invoke("save_to_cache", { key: CACHE_KEY, data: JSON.stringify(parsed) });
  return parsed;
}

export function BookshelfMetadataProvider({ children }: { children: ReactNode }) {
  const [metadata, setMetadata] = useState<BookshelfMetadata | null>(null);

  useEffect(() => {
    let alive = true;
    void loadCached().then((cached) => {
      if (alive && cached) setMetadata(cached);
    });
    void refreshRemote()
      .then((fresh) => {
        if (alive && fresh) setMetadata(fresh);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    currentMetadata = metadata;
  }, [metadata]);

  const resolveArt = useCallback(
    async (kind: "covers" | "banners", key: string): Promise<ResolvedArt | null> => {
      if (!metadata) return null;
      const art = metadata[kind][sanitizeCoverKey(key)];
      if (!art) return null;
      // Route through the cache-through protocol. It serves a content-addressed
      // local copy when available and fetches from jsDelivr only on a cache miss.
      // Unlike asset:// this also works when the user selects a custom data root.
      return {
        ...art,
        url: proxyUrl(`${RESOURCE_ROOT}/${art.path}?v=${metadata.version}`),
      };
    },
    [metadata]
  );

  const value = useMemo(() => ({ metadata, resolveArt }), [metadata, resolveArt]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useBookshelfMetadata(): ContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("useBookshelfMetadata must be used inside BookshelfMetadataProvider");
  return value;
}

/** Non-React access used while booting the isolated scenario iframe. */
export function scenarioLinkOverrides(): Record<string, ScenarioLinkOverride> {
  return currentMetadata?.scenarioLinks ?? {};
}

export function sanitizeCoverKey(key: string): string {
  return key.replace(/[/\\:*?"<>|]/g, "_");
}
