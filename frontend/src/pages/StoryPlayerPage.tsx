import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { bootEngineInFrame } from "../lib/engineBoot";
import { loadBundle } from "../lib/predownload";
import { setReading } from "../lib/keepalive";
import { markRead, setLastWatched } from "../lib/readState";
import { setLandscape } from "../lib/orientation";
import { setImmersive } from "../lib/immersive";
import { useHidePlayerBack } from "../lib/uiSettings";

/**
 * Story player page — loads the ORIGINAL PRTS ScenarioSimulator engine via bootEngine().
 * All CDN requests are proxied through the prts-cdn:// custom protocol (offline-first).
 */

interface StoryPageData {
  script: string;
  title: string;
}

export default function StoryPlayerPage() {
  const { pageTitle } = useParams<{ pageTitle: string }>();
  const navigate = useNavigate();
  const hidePlayerBack = useHidePlayerBack();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("正在加载...");
  const [error, setError] = useState<string | null>(null);

  const decodedTitle = pageTitle ? decodeURIComponent(pageTitle) : "";

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
        // === Step 1: Widget bundle (cached) ===
        setStatus("正在获取引擎代码...");
        const bundle = await loadBundle();
        if (cancelled) return;

        // === Step 2: Story script (cached) ===
        setStatus(`正在获取剧情: ${decodedTitle}...`);
        let storyData: StoryPageData;
        const cacheKey = `stories_${decodedTitle.replace(/\//g, "_")}`;
        const cachedStory = await invoke<string | null>("load_from_cache", { key: cacheKey });
        if (cachedStory) {
          storyData = JSON.parse(cachedStory);
        } else {
          storyData = await invoke<StoryPageData>("fetch_story_page", { pageTitle: decodedTitle });
          await invoke("save_to_cache", { key: cacheKey, data: JSON.stringify(storyData) }).catch(() => {});
        }
        if (cancelled) return;

        // === Step 3: Boot the engine inside an isolated iframe realm ===
        setStatus("正在初始化播放器...");
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#000;";
        container.innerHTML = "";
        container.appendChild(iframe);
        await bootEngineInFrame({
          iframe,
          bundle,
          script: storyData.script,
          title: decodedTitle,
          mode: "play",
          isCancelled: () => cancelled,
        });

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

