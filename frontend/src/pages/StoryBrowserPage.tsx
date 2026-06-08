import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStoryIndex } from "../hooks/useStoryIndex";
import { runPredownload, isOfflineError } from "../lib/predownload";
import type { PredownloadStatus, PredownloadSession } from "../lib/predownload";

/** Human-readable transfer speed, e.g. "1.2 MB/s". */
function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

export default function StoryBrowserPage() {
  const { index, loading, error, refresh } = useStoryIndex();
  const [search, setSearch] = useState("");
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});
  const [cachedStories, setCachedStories] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<PredownloadStatus | null>(null);
  const [session, setSession] = useState<PredownloadSession | null>(null);
  const navigate = useNavigate();

  const busy = status !== null;

  const startPredownload = async (titles: string[]) => {
    if (busy) return; // already running
    setStatus({ phase: "manifest", paused: false, done: 0, total: titles.length });
    setSession(null);
    try {
      const { cancelled, job } = await runPredownload(titles, setStatus, setSession);
      const verb = cancelled ? "已取消" : "完成";
      const tail = job
        ? `：资源 ${job.total} 个，成功 ${job.success}，跳过 ${job.skipped}，失败 ${job.failed}`
        : "";
      alert(`预下载${verb}${tail}`);
      invoke<string[]>("list_cached_stories").then((list) => setCachedStories(new Set(list))).catch(() => {});
    } catch (e) {
      alert(
        isOfflineError(e)
          ? "当前为离线模式，无法下载。请先在「设置 → 联网策略」中开启联网。"
          : `预下载失败: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setStatus(null);
      setSession(null);
    }
  };

  const togglePause = () => {
    if (!session || !status) return;
    if (status.paused) session.resume();
    else session.pause();
  };

  // Load cached story list
  useEffect(() => {
    invoke<string[]>("list_cached_stories").then((list) => {
      setCachedStories(new Set(list));
    }).catch(() => {});
  }, []);

  const filteredIndex = useMemo(() => {
    if (!index || !search.trim()) return index;
    const q = search.trim().toLowerCase();

    return {
      categories: index.categories
        .map((cat) => ({
          ...cat,
          chapters: cat.chapters
            .map((ch) => ({
              ...ch,
              stories: ch.stories.filter(
                (s) =>
                  s.title.toLowerCase().includes(q) ||
                  s.page_title.toLowerCase().includes(q)
              ),
            }))
            .filter((ch) => ch.stories.length > 0),
        }))
        .filter((cat) => cat.chapters.length > 0),
    };
  }, [index, search]);

  const toggleCategory = (name: string) => {
    setOpenCategories((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const isCached = (pageTitle: string): boolean => {
    const key = `stories_${pageTitle.replace(/\//g, "_")}`;
    return cachedStories.has(key);
  };

  const playStory = (pageTitle: string) => {
    navigate(`/play/${encodeURIComponent(pageTitle)}`);
  };

  if (loading && !index) {
    return <div className="loading">正在加载剧情目录...</div>;
  }

  if (error && !index) {
    return (
      <div className="error-msg">
        <p>加载剧情目录失败: {error}</p>
        <button className="btn-primary" onClick={refresh} style={{ marginTop: "12px" }}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="browser-page story-browser">
      <div className="browser-header">
        <button className="nav-btn" onClick={() => navigate("/")}>◀</button>
        <h1>剧情一览</h1>
        <input
          className="search-input"
          type="text"
          placeholder="搜索剧情..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="nav-btn" onClick={refresh} title="刷新">↻</button>
      </div>

      <div className="browser-content">
        {filteredIndex?.categories.map((cat) => (
          <div key={cat.name} className="category">
            <div
              className="category-header"
              onClick={() => toggleCategory(cat.name)}
            >
              <span className={`arrow ${openCategories[cat.name] !== false ? "open" : ""}`}>
                ▶
              </span>
              {cat.name}
              <span style={{ fontSize: "13px", color: "var(--text-secondary)", marginLeft: "auto" }}>
                {cat.chapters.reduce((n, ch) => n + ch.stories.length, 0)} 个剧情
              </span>
              <button
                className="nav-btn"
                style={{ marginLeft: "12px", fontSize: "12px" }}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  startPredownload(cat.chapters.flatMap((ch) => ch.stories.map((s) => s.page_title)));
                }}
                title="预下载本分类全部资源"
              >
                ⬇ 预下载
              </button>
            </div>

            {openCategories[cat.name] !== false && (
              <div>
                {cat.chapters.map((ch, ci) => (
                  <div key={ci} className="chapter">
                    <div className="chapter-name">
                      {ch.name}
                      <button
                        className="nav-btn"
                        style={{ marginLeft: "10px", fontSize: "11px" }}
                        disabled={busy}
                        onClick={() => startPredownload(ch.stories.map((s) => s.page_title))}
                        title="预下载本章资源"
                      >
                        ⬇
                      </button>
                    </div>
                    <div className="story-list">
                      {ch.stories.map((story, si) => (
                        <span
                          key={si}
                          className={`story-link ${isCached(story.page_title) ? "cached" : ""}`}
                          onClick={() => playStory(story.page_title)}
                          title={story.page_title}
                        >
                          {story.title}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {filteredIndex?.categories.length === 0 && (
          <div className="loading">未找到剧情</div>
        )}
      </div>

      {status && (
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
          <span style={{ flex: "0 0 auto" }}>
            {status.phase === "manifest"
              ? `${status.paused ? "已暂停·" : ""}解析清单 ${status.done}/${status.total}`
              : `${status.paused ? "已暂停·" : ""}下载 ${status.done}/${status.total}` +
                ((status.skipped ?? 0) > 0 ? `（跳过 ${status.skipped}）` : "") +
                ((status.failed ?? 0) > 0 ? `（失败 ${status.failed}）` : "")}
          </span>
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
      )}
    </div>
  );
}
