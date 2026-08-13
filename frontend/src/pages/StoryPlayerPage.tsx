import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { bootEngineInFrame } from "../lib/engineBoot";
import { loadStoryRuntime } from "../lib/predownload";
import { setReading } from "../lib/keepalive";
import { useCompression } from "../lib/CompressionContext";
import { markRead, setLastWatched } from "../lib/readState";
import { setLandscape } from "../lib/orientation";
import { setImmersive } from "../lib/immersive";
import { useHidePlayerBack } from "../lib/uiSettings";

/**
 * Story player page — loads the ORIGINAL PRTS ScenarioSimulator engine via bootEngine().
 * All CDN requests are proxied through the prts-cdn:// custom protocol (offline-first).
 */

export default function StoryPlayerPage() {
  const { pageTitle } = useParams<{ pageTitle: string }>();
  const navigate = useNavigate();
  const hidePlayerBack = useHidePlayerBack();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("正在加载...");
  const [error, setError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  const decodedTitle = pageTitle ? decodeURIComponent(pageTitle) : "";
  const { busy: compressionBusy } = useCompression();

  // Safety net: if a compression batch is active (e.g. the app restarted onto a
  // restored /play route while the batch resumes), bounce out of the reader —
  // reading would fetch+write media the batch is concurrently rewriting.
  useEffect(() => {
    if (compressionBusy) navigate("/browse", { replace: true });
  }, [compressionBusy, navigate]);

  // Drive the Android keep-alive notification's "reading a story" state.
  useEffect(() => {
    setReading(true);
    return () => setReading(false);
  }, []);

  // Record this as the "last watched" story on entry; only mark it READ after
  // 30s in the reader (so merely peeking in doesn't count). Leaving early cancels.
  useEffect(() => {
    if (!decodedTitle) return;
    setLastWatched(decodedTitle);
    const t = setTimeout(() => markRead(decodedTitle), 30_000);
    return () => clearTimeout(t);
  }, [decodedTitle]);

  // The player is the ONLY screen forced to landscape AND the only one that hides
  // the system bars (immersive); both are restored on leave. (No-op off Android.)
  useEffect(() => {
    setLandscape(true);
    setImmersive(true);
    return () => {
      setLandscape(false);
      setImmersive(false);
    };
  }, []);

  useEffect(() => {
    if (!decodedTitle || !containerRef.current) return;

    let cancelled = false;
    const container = containerRef.current;

    (async () => {
      try {
        // Script + engine/data tables come from the same fresh PRTS response. If
        // refresh fails, a validated last-known-good snapshot is retained visibly.
        setStatus(`正在同步剧情与演出引擎: ${decodedTitle}...`);
        const runtime = await loadStoryRuntime(decodedTitle);
        if (runtime.source !== "live") {
          setSyncWarning("PRTS 同步失败，当前使用上次验证成功的离线快照；建议联网后重新进入。\n" + (runtime.warning || ""));
        }
        if (cancelled) return;

        // === Step 3: Boot the engine inside an isolated iframe realm ===
        setStatus("正在初始化播放器...");
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#000;";
        container.innerHTML = "";
        container.appendChild(iframe);
        let boot;
        try {
          boot = await bootEngineInFrame({
            iframe,
            bundle: runtime.bundle,
            script: runtime.story.script,
            title: decodedTitle,
            mode: "play",
            isCancelled: () => cancelled,
          });
        } catch (candidateError) {
          if (!runtime.fallback || cancelled) throw candidateError;
          setSyncWarning(
            `PRTS 最新演出引擎启动失败，已自动切换到上一可用版本。\n${candidateError instanceof Error ? candidateError.message : String(candidateError)}`
          );
          iframe.remove();
          const fallbackFrame = document.createElement("iframe");
          fallbackFrame.style.cssText = "width:100%;height:100%;border:0;display:block;background:#000;";
          container.appendChild(fallbackFrame);
          boot = await bootEngineInFrame({
            iframe: fallbackFrame,
            bundle: runtime.fallback.bundle,
            script: runtime.fallback.story.script,
            title: decodedTitle,
            mode: "play",
            isCancelled: () => cancelled,
          });
        }

        if (boot.audit?.missing.length) {
          setSyncWarning(`演出资源表校验发现 ${boot.audit.missing.length} 项缺失：\n${boot.audit.missing.slice(0, 8).join("\n")}`);
        }

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      // Removing the iframe disposes the whole engine realm (timers, audio, globals).
      try {
        container
          .querySelector("iframe")
          ?.contentDocument?.querySelectorAll("#sys_audio audio")
          .forEach((el) => (el as HTMLAudioElement).pause());
      } catch {
        // ignore cross-realm access errors
      }
      container.innerHTML = "";
    };
  }, [decodedTitle]);

  // Pop one history level (back to the 章节 detail we came from), so hardware
  // back and this button behave identically.
  const handleBack = () => navigate(-1);

  if (error) {
    return (
      <div style={centerStyle}>
        <div style={{ color: "#f44336", marginBottom: "16px" }}>加载失败: {error}</div>
        <button onClick={handleBack} style={btnStyle}>返回</button>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", background: "#000", position: "relative" }}>
      {!hidePlayerBack && <button onClick={handleBack} style={backBtnStyle} aria-label="返回" title="返回">◀</button>}

      {syncWarning && (
        <div style={warningStyle} role="status">
          {syncWarning}
          <button onClick={() => setSyncWarning(null)} style={warningCloseStyle}>知道了</button>
        </div>
      )}

      {loading && (
        <div style={centerStyle}>
          <div style={{ color: "#929292", fontSize: "16px" }}>{status}</div>
        </div>
      )}

      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", display: loading ? "none" : "block" }}
      />
    </div>
  );
}

const centerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  flexDirection: "column",
  gap: "16px",
  background: "#000",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 20px",
  background: "#f4c430",
  color: "#000",
  border: "none",
  borderRadius: "4px",
  fontSize: "14px",
  cursor: "pointer",
};

const warningStyle: React.CSSProperties = {
  position: "fixed",
  top: "calc(8px + var(--safe-top))",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10000,
  maxWidth: "min(760px, 80vw)",
  padding: "8px 12px",
  whiteSpace: "pre-wrap",
  color: "#fff3cd",
  background: "rgba(92, 67, 0, 0.94)",
  border: "1px solid #d6a900",
  borderRadius: "6px",
  fontSize: "12px",
  lineHeight: 1.4,
};

const warningCloseStyle: React.CSSProperties = {
  marginLeft: "12px",
  padding: "3px 8px",
  color: "#111",
  background: "#f4c430",
  border: 0,
  borderRadius: "3px",
};

// Small, unobtrusive icon-only back button in the corner (the reader is meant to
// be immersive; the system back gesture also works).
const backBtnStyle: React.CSSProperties = {
  position: "fixed",
  top: "calc(6px + var(--safe-top))",
  left: "calc(6px + var(--safe-left))",
  zIndex: 9999,
  width: "30px",
  height: "30px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "rgba(0,0,0,0.4)",
  color: "rgba(255,255,255,0.85)",
  border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: "50%",
  cursor: "pointer",
  fontSize: "14px",
  lineHeight: 1,
};
