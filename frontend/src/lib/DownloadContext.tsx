import { createContext, useContext, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { runPredownload, isOfflineError } from "./predownload";
import type { PredownloadStatus, PredownloadSession } from "./predownload";
import { useCompression } from "./CompressionContext";

/**
 * App-wide predownload state. Lives at the App root so a running download (and its
 * progress bar) survives page navigation — downloads are high-priority and must
 * stay visible everywhere except inside the reader. The download job itself runs
 * in Rust; this just keeps the UI state/controls alive across route changes.
 */
/** A finished-run summary, shown in a dismissible panel (with copyable failures). */
interface DownloadResult {
  message: string;
  failedKeys: string[];
}

interface DownloadContextValue {
  status: PredownloadStatus | null;
  session: PredownloadSession | null;
  busy: boolean;
  /** Last finished-run summary (until dismissed). */
  result: DownloadResult | null;
  dismissResult: () => void;
  /** Start a predownload over the given story page-titles (no-op if one is running). */
  start: (titles: string[]) => Promise<void>;
  /** Register a callback fired whenever a run finishes (e.g. to refresh cache lists). */
  onFinished: (cb: () => void) => () => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

// Provider + its hook intentionally co-located (HMR-only lint rule).
// eslint-disable-next-line react-refresh/only-export-components
export function useDownload(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error("useDownload must be used within <DownloadProvider>");
  return ctx;
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PredownloadStatus | null>(null);
  const [session, setSession] = useState<PredownloadSession | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const runningRef = useRef(false);
  const finishedListeners = useRef<Set<() => void>>(new Set());
  // Block starting downloads while an image-compression batch rewrites the store
  // (the Rust side enforces this too; this gives an immediate, clear message).
  const { busy: compressionBusy } = useCompression();

  const onFinished = useCallback((cb: () => void) => {
    finishedListeners.current.add(cb);
    return () => {
      finishedListeners.current.delete(cb);
    };
  }, []);

  const start = useCallback(async (titles: string[]) => {
    if (runningRef.current || titles.length === 0) return;
    if (compressionBusy) {
      setResult({ message: "正在进行记忆重组（资源压缩），请等待完成后再下载。", failedKeys: [] });
      return;
    }
    runningRef.current = true;
    setStatus({
      paused: false,
      manifestDone: 0,
      manifestTotal: titles.length,
      manifestActive: true,
      done: 0,
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      bytesPerSec: 0,
    });
    setSession(null);
    try {
      const { cancelled, job } = await runPredownload(titles, setStatus, setSession);
      const verb = cancelled ? "已取消" : "完成";
      const failed = job?.failedKeys ?? [];
      // Show new vs. already-cached, and surface any assets that failed after retries
      // (e.g. missing 立绘) so they're diagnosable instead of vanishing into a count.
      const tail = job
        ? `：共 ${job.total} 个资源，新下载 ${job.success} 个，已缓存 ${job.skipped} 个` +
          (failed.length ? `，失败 ${failed.length} 个` : "")
        : "";
      if (failed.length) {
        console.warn("[predownload] 失败资源:\n" + failed.join("\n"));
      }
      setResult({ message: `预下载${verb}${tail}`, failedKeys: failed });
      finishedListeners.current.forEach((f) => f());
    } catch (e) {
      setResult({
        message: isOfflineError(e)
          ? "当前为离线模式，无法下载。请先在「设置 → 联网策略」中开启联网。"
          : `预下载失败: ${e instanceof Error ? e.message : String(e)}`,
        failedKeys: [],
      });
    } finally {
      runningRef.current = false;
      setStatus(null);
      setSession(null);
    }
  }, [compressionBusy]);

  return (
    <DownloadContext.Provider
      value={{
        status,
        session,
        busy: status !== null,
        result,
        dismissResult: () => setResult(null),
        start,
        onFinished,
      }}
    >
      {children}
    </DownloadContext.Provider>
  );
}
