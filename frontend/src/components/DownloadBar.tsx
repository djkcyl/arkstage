import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useDownload } from "../lib/DownloadContext";
import { useCompression } from "../lib/CompressionContext";
import { copyText } from "../lib/diagnostics";

/** Dismissible summary panel for a finished run, with copyable failure list. */
function ResultPanel() {
  const { result, dismissResult } = useDownload();
  const [copied, setCopied] = useState(false);
  if (!result) return null;
  const { message, failedKeys } = result;
  const copy = async () => {
    await copyText(`${message}\n\n失败资源（${failedKeys.length}）：\n${failedKeys.join("\n")}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="dl-result-overlay" onClick={dismissResult}>
      <div className="dl-result" onClick={(e) => e.stopPropagation()}>
        <div className="dl-result-msg">{message}</div>
        {failedKeys.length > 0 && (
          <>
            <div className="dl-result-sub">
              失败资源（已重试多次，多为 prts 上缺失的音/视频，不影响剧情）：
            </div>
            <textarea className="dl-result-list" readOnly value={failedKeys.join("\n")} />
          </>
        )}
        <div className="dl-result-actions">
          {failedKeys.length > 0 && (
            <button className="nav-btn" onClick={copy}>
              {copied ? "已复制 ✓" : "复制失败列表"}
            </button>
          )}
          <button className="nav-btn" onClick={dismissResult}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** Human-readable transfer speed, e.g. "1.2 MB/s". */
function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

/** One labelled progress row (label on the left, a thin fill bar on the right). */
function ProgressRow({ label, pct, dim }: { label: string; pct: number; dim?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", opacity: dim ? 0.55 : 1 }}>
      <span style={{ flex: "0 0 auto", minWidth: "118px" }}>{label}</span>
      <div
        style={{
          flex: "1 1 auto",
          height: "5px",
          background: "rgba(255,255,255,0.15)",
          borderRadius: "3px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.min(100, Math.max(0, pct))}%`,
            height: "100%",
            background: "#f4c430",
            transition: "width 0.2s",
          }}
        />
      </div>
    </div>
  );
}

/** Dismissible summary panel for a finished compression run. */
function CompressResultPanel() {
  const { result, dismissResult } = useCompression();
  if (!result) return null;
  return (
    <div className="dl-result-overlay" onClick={dismissResult}>
      <div className="dl-result" onClick={(e) => e.stopPropagation()}>
        <div className="dl-result-msg">{result.message}</div>
        <div className="dl-result-actions">
          <button className="nav-btn" onClick={dismissResult}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** Bottom bar mirroring the download bar, for the image-compression batch. */
function CompressBar() {
  const { status, pause, resume, cancel } = useCompression();
  if (!status) return null;
  const pct = status.total > 0 ? (status.done / status.total) * 100 : 0;
  const prefix = status.status === "paused" ? "已暂停·" : "";
  const freed = `${(status.freedBytes / 1024 / 1024).toFixed(1)} MB`;
  const label = `${prefix}记忆重组 ${status.done}/${status.total}`;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "6px 16px",
        background: "rgba(0,0,0,0.85)",
        color: "#f4c430",
        fontSize: "12px",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: "4px" }}>
        <ProgressRow label={label} pct={pct} />
      </div>
      <span style={{ flex: "0 0 auto", minWidth: "72px", textAlign: "right" }}>已省 {freed}</span>
      <button
        className="nav-btn"
        style={{ fontSize: "12px" }}
        onClick={() => (status.status === "paused" ? resume() : pause())}
      >
        {status.status === "paused" ? "继续" : "暂停"}
      </button>
      <button className="nav-btn" style={{ fontSize: "12px" }} onClick={cancel}>
        取消
      </button>
    </div>
  );
}

/**
 * Global, high-priority download progress. Rendered above the routes so it
 * persists across navigation; hidden only inside the reader (`/play/*`).
 * Indexing (索引) and downloading (下载) run concurrently, so it shows BOTH bars.
 * A compression batch (记忆重组) is mutually exclusive with downloads and takes
 * the bar when active.
 */
export default function DownloadBar() {
  const { status, session } = useDownload();
  const compression = useCompression();
  const { pathname } = useLocation();

  if (pathname.startsWith("/play/")) return null;
  // Compression batch takes priority (downloads are gated off while it runs).
  if (compression.status) {
    return (
      <>
        <CompressBar />
        <CompressResultPanel />
      </>
    );
  }
  // The result panel shows after a run (status cleared); the progress bar only while running.
  if (!status)
    return (
      <>
        <ResultPanel />
        <CompressResultPanel />
      </>
    );

  const togglePause = () => {
    if (!session) return;
    if (status.paused) session.resume();
    else session.pause();
  };

  const pct = (d: number, t: number) => (t > 0 ? (d / t) * 100 : 0);
  const prefix = status.paused ? "已暂停·" : "";
  const idxLabel = `${prefix}索引 ${status.manifestDone}/${status.manifestTotal}`;
  // Failures are auto-retried in the background and never surfaced — show only
  // the "already cached" (skipped) count alongside progress.
  const dlExtra = status.skipped > 0 ? ` 跳过${status.skipped}` : "";
  const dlLabel = `${prefix}下载 ${status.done}/${status.total}${dlExtra}`;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "6px 16px",
        background: "rgba(0,0,0,0.85)",
        color: "#f4c430",
        fontSize: "12px",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: "4px" }}>
        <ProgressRow label={idxLabel} pct={pct(status.manifestDone, status.manifestTotal)} dim={!status.manifestActive} />
        <ProgressRow label={dlLabel} pct={pct(status.done, status.total)} />
      </div>
      <span style={{ flex: "0 0 auto", minWidth: "64px", textAlign: "right" }}>
        {status.paused ? "—" : fmtSpeed(status.bytesPerSec)}
      </span>
      <button className="nav-btn" style={{ fontSize: "12px" }} onClick={togglePause}>
        {status.paused ? "继续" : "暂停"}
      </button>
      <button className="nav-btn" style={{ fontSize: "12px" }} onClick={() => session?.cancel()}>
        取消
      </button>
      <ResultPanel />
    </div>
  );
}
