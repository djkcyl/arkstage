import { useEffect, useState } from "react";
import { clearLog, getEntries, subscribe, type LogEntry } from "../lib/debugLog";
import { isDebugConsoleEnabled, subscribeDebugSetting } from "../lib/debugSettings";

/**
 * Always-mounted floating debug console. Shows errors/warnings captured from the
 * main window and the engine iframe (see debugLog.ts), so the user can read and
 * screenshot the real failure even when WebView DevTools aren't available.
 *
 * Collapsed to a small button by default; the button turns red and shows a count
 * when errors are present.
 */
export default function DebugConsole() {
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  // Re-render when the user flips the debug-console setting so it can show/hide live.
  useEffect(() => subscribeDebugSetting(() => force((n) => n + 1)), []);

  // Hidden unless enabled (build default, overridable in Settings).
  if (!isDebugConsoleEnabled()) return null;

  const entries = getEntries();
  const errorCount = entries.filter((e) => e.level === "error").length;

  const copyAll = () => {
    const text = entries.map((e) => `[${levelTag(e)}] ${e.msg}`).join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...toggleStyle, background: errorCount ? "#b71c1c" : "rgba(0,0,0,0.6)" }}
        title="查看调试日志"
      >
        调试日志{errorCount ? ` (${errorCount})` : entries.length ? ` ·${entries.length}` : ""}
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>调试日志 ({entries.length})</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={copyAll} style={smallBtn}>复制</button>
          <button onClick={clearLog} style={smallBtn}>清空</button>
          <button onClick={() => setOpen(false)} style={smallBtn}>收起</button>
        </div>
      </div>
      <div style={listStyle}>
        {entries.length === 0 && <div style={{ color: "#888" }}>暂无日志</div>}
        {entries.map((e) => (
          <div key={e.id} style={{ color: levelColor(e.level), whiteSpace: "pre-wrap", marginBottom: 4 }}>
            [{levelTag(e)}] {e.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function levelTag(e: LogEntry): string {
  const d = new Date(e.time);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${t} ${e.level.toUpperCase()}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function levelColor(level: string): string {
  if (level === "error") return "#ff6b6b";
  if (level === "warn") return "#ffd166";
  return "#cfcfcf";
}

const toggleStyle: React.CSSProperties = {
  position: "fixed",
  bottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
  zIndex: 99999,
  padding: "4px 10px",
  color: "white",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
};

const panelStyle: React.CSSProperties = {
  position: "fixed",
  bottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
  zIndex: 99999,
  width: "min(720px, 90vw)",
  height: "min(320px, 50vh)",
  background: "rgba(15,15,15,0.96)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  color: "white",
  fontSize: 13,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 10px",
  fontFamily: "monospace",
  fontSize: 12,
  lineHeight: 1.4,
};

const smallBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "rgba(255,255,255,0.12)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
};
