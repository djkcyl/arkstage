import { useLocation } from "react-router-dom";
import { useDownload } from "../lib/DownloadContext";

/** Human-readable transfer speed, e.g. "1.2 MB/s". */
function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

/**
 * Global, high-priority download progress bar. Rendered above the routes so it
 * persists across navigation; hidden only inside the reader (`/play/*`) where it
 * would overlap the player, and when nothing is downloading.
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

  const label =
    status.phase === "manifest"
      ? `${status.paused ? "已暂停·" : ""}解析清单 ${status.done}/${status.total}`
      : `${status.paused ? "已暂停·" : ""}下载 ${status.done}/${status.total}` +
        ((status.skipped ?? 0) > 0 ? `（跳过 ${status.skipped}）` : "") +
        ((status.failed ?? 0) > 0 ? `（失败 ${status.failed}）` : "");

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        padding: "8px 16px",
        background: "rgba(0,0,0,0.85)",
        color: "#f4c430",
        fontSize: "13px",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <span style={{ flex: "0 0 auto" }}>{label}</span>
      <div
        style={{
          flex: "1 1 auto",
          height: "6px",
          background: "rgba(255,255,255,0.15)",
          borderRadius: "3px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${status.total ? (status.done / status.total) * 100 : 0}%`,
            height: "100%",
            background: "#f4c430",
            transition: "width 0.2s",
          }}
        />
      </div>
      <span style={{ flex: "0 0 auto", minWidth: "64px", textAlign: "right" }}>
        {status.phase === "download" && !status.paused ? fmtSpeed(status.bytesPerSec ?? 0) : "—"}
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
