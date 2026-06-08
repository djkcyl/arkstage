import { useLocation } from "react-router-dom";
import { useDownload } from "../lib/DownloadContext";

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

/**
 * Global, high-priority download progress. Rendered above the routes so it
 * persists across navigation; hidden only inside the reader (`/play/*`).
 * Indexing (索引) and downloading (下载) run concurrently, so it shows BOTH bars.
 */
export default function DownloadBar() {
  const { status, session } = useDownload();
  const { pathname } = useLocation();

  if (!status) return null;
  if (pathname.startsWith("/play/")) return null;

  const togglePause = () => {
    if (!session) return;
    if (status.paused) session.resume();
    else session.pause();
  };

  const pct = (d: number, t: number) => (t > 0 ? (d / t) * 100 : 0);
  const prefix = status.paused ? "已暂停·" : "";
  const idxLabel = `${prefix}索引 ${status.manifestDone}/${status.manifestTotal}`;
  const dlExtra =
    (status.skipped > 0 ? ` 跳过${status.skipped}` : "") + (status.failed > 0 ? ` 失败${status.failed}` : "");
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
    </div>
  );
}
