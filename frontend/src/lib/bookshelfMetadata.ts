export const RESOURCE_ROOTS = {
  jsdelivr: "https://cdn.jsdelivr.net/gh/djkcyl/arkstage@resources",
  github: "https://raw.githubusercontent.com/djkcyl/arkstage/resources",
} as const;

export type ResourceSource = keyof typeof RESOURCE_ROOTS;
const REMOTE_SOURCES = Object.entries(RESOURCE_ROOTS) as [ResourceSource, string][];
export const DEFAULT_FALLBACK_CATEGORY = "特殊&未分类";

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
  fallbackCategory: string;
}

export interface RemoteMetadata {
  metadata: BookshelfMetadata;
  source: ResourceSource;
}

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
    storylines.push([entry[0] === "特殊" ? DEFAULT_FALLBACK_CATEGORY : entry[0], [...entry[1]]]);
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
  const fallbackCategory = raw.fallbackCategory === undefined
    ? DEFAULT_FALLBACK_CATEGORY
    : typeof raw.fallbackCategory === "string" && raw.fallbackCategory.trim().length > 0 && raw.fallbackCategory.length <= 64
      ? raw.fallbackCategory
      : null;
  if (!fallbackCategory) return null;
  return {
    schemaVersion: 1,
    version: raw.version,
    storylines,
    covers,
    banners,
    scenarioLinks,
    fallbackCategory: fallbackCategory === "特殊" ? DEFAULT_FALLBACK_CATEGORY : fallbackCategory,
  };
}

/** Try jsDelivr first, then GitHub Raw. Invalid responses never become usable metadata. */
export async function fetchRemoteBookshelfMetadata(
  fetcher: typeof fetch = fetch,
  timeoutMs = 12_000
): Promise<RemoteMetadata> {
  const errors: string[] = [];
  for (const [source, root] of REMOTE_SOURCES) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${root}/metadata.json`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseBookshelfMetadata(await response.json());
      if (!parsed) throw new Error("元数据格式无效");
      return { metadata: parsed, source };
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw new Error(errors.join("；"));
}
