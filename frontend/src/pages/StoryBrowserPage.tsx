import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStoryIndex } from "../hooks/useStoryIndex";
import { useDownload } from "../lib/DownloadContext";

export default function StoryBrowserPage() {
  const { index, loading, error, refresh } = useStoryIndex();
  const [search, setSearch] = useState("");
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});
  const [cachedStories, setCachedStories] = useState<Set<string>>(new Set());
  const { start: startPredownload, busy, onFinished } = useDownload();
  const navigate = useNavigate();

  const refreshCached = () =>
    invoke<string[]>("list_cached_stories")
      .then((list) => setCachedStories(new Set(list)))
      .catch(() => {});

  // Load cached story list, and refresh it whenever a (global) download finishes.
  useEffect(() => {
    refreshCached();
    return onFinished(refreshCached);
  }, [onFinished]);

  const filteredIndex = useMemo(() => {
    if (!index || !search.trim()) return index;
    const q = search.trim().toLowerCase();

    return {
      categories: index.categories
        .map((cat) => ({
          ...cat,
          chapters: cat.chapters
            .map((ch) => {
              // Matching the activity/chapter name keeps all of its stories.
              const chapterMatch =
                ch.name.toLowerCase().includes(q) ||
                (ch.activity_name?.toLowerCase().includes(q) ?? false);
              return {
                ...ch,
                stories: chapterMatch
                  ? ch.stories
                  : ch.stories.filter(
                      (s) =>
                        s.title.toLowerCase().includes(q) ||
                        s.page_title.toLowerCase().includes(q)
                    ),
              };
            })
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
                      {ch.activity_name && (
                        <span className="chapter-activity">{ch.activity_name}</span>
                      )}
                      <span className="chapter-label">{ch.name}</span>
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
      {/* Progress is rendered globally by <DownloadBar> so it survives navigation. */}
    </div>
  );
}
