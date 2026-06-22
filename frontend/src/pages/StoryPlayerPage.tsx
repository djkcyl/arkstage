import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { bootEngineInFrame } from "../lib/engineBoot";
import { loadBundle } from "../lib/predownload";
import { setReading } from "../lib/keepalive";
import { markRead } from "../lib/readState";
import { setLandscape } from "../lib/orientation";

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

  // The player is the ONLY screen forced to landscape; restore free orientation
  // on leave. (No-op off Android.)
  useEffect(() => {
    setLandscape(true);
    return () => {
      setLandscape(false);
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

        markRead(decodedTitle); // opened in the player → counts as read
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

  const handleBack = () => navigate("/browse");

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
      <button onClick={handleBack} style={backBtnStyle}>◀ 返回</button>

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

const backBtnStyle: React.CSSProperties = {
  position: "fixed",
  top: "calc(8px + env(safe-area-inset-top, 0px))",
  left: "calc(8px + env(safe-area-inset-left, 0px))",
  zIndex: 9999,
  padding: "4px 12px",
  background: "rgba(0,0,0,0.6)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: "3px",
  cursor: "pointer",
  fontSize: "13px",
};

