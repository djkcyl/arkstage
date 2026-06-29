import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * App-wide image-compression ("资源压缩") state. The batch runs entirely in Rust
 * (see `compress.rs`) and emits `compress://progress`; this context just mirrors
 * that state into the UI and exposes the control commands. Lives at the App root
 * (above DownloadProvider) so its progress bar survives navigation and so the
 * download flow can refuse to start while a batch runs.
 *
 * Tiers: "lossless" | "q90" | "q70". "off" means real-time compression disabled.
 */
export type Tier = "off" | "lossless" | "q90" | "q70";

export interface CompressSnapshot {
  status: "running" | "paused" | "completed" | "cancelled";
  total: number;
  done: number;
  failed: number;
  freedBytes: number;
  tier: string;
}

export interface CompressEstimate {
  totalBytes: number;
  imageBytes: number;
  nonImageBytes: number;
  losslessBytes: number;
  q90Bytes: number;
  q70Bytes: number;
  currentTier: string;
}

interface CompressConfig {
  tier: string;
  active: boolean;
}

/** A finished-run summary, shown in a dismissible panel. */
interface CompressResult {
  message: string;
}

interface CompressionContextValue {
  /** Live snapshot while running/paused; null when idle. */
  status: CompressSnapshot | null;
  busy: boolean;
  /** Current real-time tier ("off" when disabled). */
  tier: string;
  result: CompressResult | null;
  dismissResult: () => void;
  estimate: () => Promise<CompressEstimate>;
  start: (tier: Tier) => Promise<void>;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  disableRealtime: () => Promise<void>;
}

const CompressionContext = createContext<CompressionContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useCompression(): CompressionContextValue {
  const ctx = useContext(CompressionContext);
  if (!ctx) throw new Error("useCompression must be used within <CompressionProvider>");
  return ctx;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isTerminal = (s: CompressSnapshot) => s.status === "completed" || s.status === "cancelled";

export function CompressionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CompressSnapshot | null>(null);
  const [tier, setTier] = useState<string>("off");
  const [result, setResult] = useState<CompressResult | null>(null);
  // Keep the last non-terminal snapshot so the finished summary can report totals.
  const lastRef = useRef<CompressSnapshot | null>(null);

  // Subscribe once to progress; restore state on mount (covers a batch resumed by
  // the Rust side after an app restart).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    (async () => {
      try {
        const cfg = await invoke<CompressConfig>("compress_get_config");
        if (!alive) return;
        setTier(cfg.tier);
        if (cfg.active) {
          const snap = await invoke<CompressSnapshot | null>("compress_status");
          if (alive && snap) {
            lastRef.current = snap;
            setStatus(isTerminal(snap) ? null : snap);
          }
        }
      } catch {
        // ignore
      }
      unlisten = await listen<CompressSnapshot>("compress://progress", (e) => {
        const snap = e.payload;
        if (isTerminal(snap)) {
          const base = lastRef.current ?? snap;
          const freed = fmtMB(snap.freedBytes || base.freedBytes);
          setStatus(null);
          setTier(snap.tier);
          setResult({
            message:
              snap.status === "cancelled"
                ? `记忆重组已取消（已释放 ${freed}）`
                : `记忆重组完成：处理 ${snap.done}/${snap.total}，释放约 ${freed}`,
          });
        } else {
          lastRef.current = snap;
          setStatus(snap);
        }
      });
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const estimate = useCallback(() => invoke<CompressEstimate>("compress_estimate"), []);

  const start = useCallback(async (t: Tier) => {
    const snap = await invoke<CompressSnapshot>("compress_start", { tier: t });
    setTier(t);
    if (isTerminal(snap)) {
      // Nothing needed compression — surface an immediate summary.
      setResult({ message: `记忆重组完成：无需处理的资源（已是 ${t} 档）` });
    } else {
      lastRef.current = snap;
      setStatus(snap);
    }
  }, []);

  const pause = useCallback(() => void invoke("compress_pause").catch(() => {}), []);
  const resume = useCallback(() => void invoke("compress_resume").catch(() => {}), []);
  const cancel = useCallback(() => void invoke("compress_cancel").catch(() => {}), []);
  const disableRealtime = useCallback(async () => {
    await invoke("compress_disable_realtime");
    setTier("off");
  }, []);

  return (
    <CompressionContext.Provider
      value={{
        status,
        busy: status !== null,
        tier,
        result,
        dismissResult: () => setResult(null),
        estimate,
        start,
        pause,
        resume,
        cancel,
        disableRealtime,
      }}
    >
      {children}
    </CompressionContext.Provider>
  );
}
