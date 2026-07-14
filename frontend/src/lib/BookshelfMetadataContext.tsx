/* eslint-disable react-refresh/only-export-components */
import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { proxyUrl } from "./proxy";
import {
  DEFAULT_FALLBACK_CATEGORY,
  RESOURCE_ROOTS,
  fetchRemoteBookshelfMetadata,
  parseBookshelfMetadata,
  type BookshelfMetadata,
  type RemoteArt,
  type ResourceSource,
  type ScenarioLinkOverride,
} from "./bookshelfMetadata";

export { RESOURCE_ROOTS, fetchRemoteBookshelfMetadata, parseBookshelfMetadata };
export type { BookshelfMetadata, RemoteArt, ScenarioLinkOverride };
const CACHE_KEY = "bookshelf-metadata";

interface ContextValue {
  metadata: BookshelfMetadata | null;
  resolveArt: (kind: "covers" | "banners", key: string) => Promise<ResolvedArt | null>;
}

export interface ResolvedArt extends RemoteArt {
  url: string;
  fallbackUrl: string;
}

const Context = createContext<ContextValue | null>(null);
let currentMetadata: BookshelfMetadata | null = null;

async function loadCached(): Promise<BookshelfMetadata | null> {
  try {
    const cached = await invoke<string | null>("load_from_cache", { key: CACHE_KEY });
    return cached ? parseBookshelfMetadata(JSON.parse(cached)) : null;
  } catch {
    return null;
  }
}

export function BookshelfMetadataProvider({ children }: { children: ReactNode }) {
  const [metadata, setMetadata] = useState<BookshelfMetadata | null>(null);
  const [source, setSource] = useState<ResourceSource>("jsdelivr");
  const [warning, setWarning] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const metadataRef = useRef<BookshelfMetadata | null>(null);
  const generation = useRef(0);

  const applyMetadata = useCallback((next: BookshelfMetadata) => {
    metadataRef.current = next;
    currentMetadata = next;
    setMetadata(next);
  }, []);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setRefreshing(true);
    try {
      const fresh = await fetchRemoteBookshelfMetadata();
      if (request !== generation.current) return;
      applyMetadata(fresh.metadata);
      setSource(fresh.source);
      setWarning(null);
      try {
        await invoke("save_to_cache", { key: CACHE_KEY, data: JSON.stringify(fresh.metadata) });
      } catch {
        if (request === generation.current) {
          setWarning("书架信息已更新，但无法写入本地缓存；下次离线启动可能无法使用最新分类和封面。");
        }
      }
    } catch {
      if (request === generation.current) {
        setWarning(
          metadataRef.current
            ? "书架在线更新失败，已保留并使用上次成功缓存。请检查网络后重试。"
            : `无法获取书架信息；当前剧情会暂时归入“${DEFAULT_FALLBACK_CATEGORY}”并使用占位封面。请检查网络后重试。`
        );
      }
    } finally {
      if (request === generation.current) setRefreshing(false);
    }
  }, [applyMetadata]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cached = await loadCached();
      if (!alive) return;
      if (cached) applyMetadata(cached);
      await refresh();
    })();
    return () => {
      alive = false;
      generation.current += 1;
    };
  }, [applyMetadata, refresh]);

  const resolveArt = useCallback(
    async (kind: "covers" | "banners", key: string): Promise<ResolvedArt | null> => {
      if (!metadata) return null;
      const art = metadata[kind][sanitizeCoverKey(key)];
      if (!art) return null;
      // Route through the cache-through protocol. It serves a content-addressed
      // local copy when available and fetches from the preferred remote on a cache miss.
      // Unlike asset:// this also works when the user selects a custom data root.
      const primaryRoot = RESOURCE_ROOTS[source];
      const fallbackRoot = source === "jsdelivr" ? RESOURCE_ROOTS.github : RESOURCE_ROOTS.jsdelivr;
      return {
        ...art,
        url: proxyUrl(`${primaryRoot}/${art.path}?v=${metadata.version}`),
        fallbackUrl: proxyUrl(`${fallbackRoot}/${art.path}?v=${metadata.version}`),
      };
    },
    [metadata, source]
  );

  const value = useMemo(() => ({ metadata, resolveArt }), [metadata, resolveArt]);
  return (
    <Context.Provider value={value}>
      {children}
      {warning && (
        <div className="bookshelf-sync-warning" role="alert">
          <span>{warning}</span>
          <button type="button" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "重试中…" : "重试"}
          </button>
          <button type="button" className="bookshelf-sync-dismiss" onClick={() => setWarning(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
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
