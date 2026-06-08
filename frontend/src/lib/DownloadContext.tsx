import { createContext, useContext, useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { runPredownload, isOfflineError } from "./predownload";
import type { PredownloadStatus, PredownloadSession } from "./predownload";

/**
 * App-wide predownload state. Lives at the App root so a running download (and its
 * progress bar) survives page navigation — downloads are high-priority and must
 * stay visible everywhere except inside the reader. The download job itself runs
 * in Rust; this just keeps the UI state/controls alive across route changes.
 */
interface DownloadContextValue {
  status: PredownloadStatus | null;
  session: PredownloadSession | null;
  busy: boolean;
  /** Start a predownload over the given story page-titles (no-op if one is running). */
  start: (titles: string[]) => Promise<void>;
  /** Register a callback fired whenever a run finishes (e.g. to refresh cache lists). */
  onFinished: (cb: () => void) => () => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function useDownload(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error("useDownload must be used within <DownloadProvider>");
  return ctx;
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PredownloadStatus | null>(null);
  const [session, setSession] = useState<PredownloadSession | null>(null);
  const runningRef = useRef(false);
  const finishedListeners = useRef<Set<() => void>>(new Set());

  const onFinished = useCallback((cb: () => void) => {
    finishedListeners.current.add(cb);
    return () => {
      finishedListeners.current.delete(cb);
    };
  }, []);

  const start = useCallback(async (titles: string[]) => {
    if (runningRef.current || titles.length === 0) return;
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
      const tail = job
        ? `：资源 ${job.total} 个，成功 ${job.success}，跳过 ${job.skipped}，失败 ${job.failed}`
        : "";
      alert(`预下载${verb}${tail}`);
      finishedListeners.current.forEach((f) => f());
    } catch (e) {
      alert(
        isOfflineError(e)
          ? "当前为离线模式，无法下载。请先在「设置 → 联网策略」中开启联网。"
          : `预下载失败: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      runningRef.current = false;
      setStatus(null);
      setSession(null);
    }
  }, []);

  return (
    <DownloadContext.Provider value={{ status, session, busy: status !== null, start, onFinished }}>
      {children}
    </DownloadContext.Provider>
  );
}
