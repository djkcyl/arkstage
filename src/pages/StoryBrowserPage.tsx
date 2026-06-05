import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStoryIndex } from "../hooks/useStoryIndex";
import { predownloadScope } from "../lib/predownload";
import type { PreProgress } from "../lib/predownload";

export default function StoryBrowserPage() {
  const { index, loading, error, refresh } = useStoryIndex();
  const [search, setSearch] = useState("");
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});
  const [cachedStories, setCachedStories] = useState<Set<string>>(new Set());
  const [pre, setPre] = useState<PreProgress | null>(null);
  const navigate = useNavigate();

  const runPredownload = async (titles: string[]) => {
    if (pre) return; // already running
    setPre({ phase: "manifest", done: 0, total: titles.length, label: "" });
    try {
      const { assets, result } = await predownloadScope(titles, setPre);
      alert(`范围资源 ${assets} 个：成功${result.success} 跳过${result.skipped} 失败${result.failed}`);
      invoke<string[]>("list_cached_stories").then((list) => setCachedStories(new Set(list))).catch(() => {});
    } catch (e) {
      alert(`预下载失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPre(null);
    }
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
                disabled={!!pre}
                onClick={(e) => {
                  e.stopPropagation();
                  runPredownload(cat.chapters.flatMap((ch) => ch.stories.map((s) => s.page_title)));
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
                        disabled={!!pre}
                        onClick={() => runPredownload(ch.stories.map((s) => s.page_title))}
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

      {pre && (
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
          }}
        >
          {pre.phase === "manifest"
            ? `解析资源清单 ${pre.done}/${pre.total} ${pre.label}`
            : `下载资源 ${pre.total} 个…`}
        </div>
      )}
    </div>
  );
}
