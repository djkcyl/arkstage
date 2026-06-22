import { useState, useMemo } from "react";
import type { Book } from "../lib/bookshelf";
import { cachedKey } from "../lib/bookshelf";
import { coverFallback } from "../lib/cover";
import type { StoryChapter } from "../hooks/useStoryIndex";

interface Props {
  book: Book;
  cachedStories: Set<string>;
  /** Story page-titles the user has opened in the player (read). */
  readStories: Set<string>;
  /** Currently-selected story page-titles (shared across the detail view). */
  selected: Set<string>;
  busy: boolean;
  onBack: () => void;
  onPlay: (pageTitle: string) => void;
  /** Toggle one story's selection. */
  onToggleStory: (pageTitle: string) => void;
  /** Add or remove a batch of page-titles (whole chapter / range). */
  onSetMany: (pageTitles: string[], on: boolean) => void;
  /** Download / delete just this book (hero-level shortcuts). */
  onDownloadBook: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
}

/** Compact from–to range picker that adds a story slice to the selection. */
function RangeSelect({
  chapter,
  onApply,
}: {
  chapter: StoryChapter;
  onApply: (pageTitles: string[]) => void;
}) {
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Math.max(0, chapter.stories.length - 1));

  const apply = () => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    onApply(chapter.stories.slice(lo, hi + 1).map((s) => s.page_title));
  };

  return (
    <div className="range-select" onClick={(e) => e.stopPropagation()}>
      <span className="range-label">范围选择</span>
      <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
        {chapter.stories.map((s, i) => (
          <option key={i} value={i}>
            {s.title}
          </option>
        ))}
      </select>
      <span className="range-dash">—</span>
      <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
        {chapter.stories.map((s, i) => (
          <option key={i} value={i}>
            {s.title}
          </option>
        ))}
      </select>
      <button className="sel-btn" onClick={apply}>
        加入选择
      </button>
    </div>
  );
}

/**
 * Drill-in view for one book: a large hero (same cover art/gradient) plus its
 * chapters, each collapsible and listing its stories. Stories and whole chapters
 * are multi-selectable; each chapter also offers a from–to range picker. The
 * view is in-page state (no route push) so hardware-back stays on the shelf.
 */
export default function ChapterDetail({
  book,
  cachedStories,
  readStories,
  selected,
  busy,
  onBack,
  onPlay,
  onToggleStory,
  onSetMany,
  onDownloadBook,
  onDeleteBook,
}: Props) {
  const fallback = useMemo(() => coverFallback(book.coverKey), [book.coverKey]);
  // Default: all chapters open.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const isCached = (pt: string) => cachedStories.has(cachedKey(pt));
  const isRead = (pt: string) => readStories.has(pt);
  const allSelected = book.pageTitles.length > 0 && book.pageTitles.every((pt) => selected.has(pt));

  const cachedCount = useMemo(
    () => book.pageTitles.filter((pt) => cachedStories.has(cachedKey(pt))).length,
    [book.pageTitles, cachedStories]
  );

  const chapterState = (ch: StoryChapter): { all: boolean; some: boolean } => {
    const sel = ch.stories.filter((s) => selected.has(s.page_title)).length;
    return { all: sel === ch.stories.length && sel > 0, some: sel > 0 };
  };

  return (
    <div className="chapter-detail">
      <div className="detail-hero" style={{ background: fallback.background }}>
        <div className="hero-scrim" />
        <button className="hero-back nav-btn" onClick={onBack}>
          ◀ 返回
        </button>
        <div className="hero-meta">
          <div className="hero-cat">{book.category}</div>
          <h1 className="hero-title">{book.coverKey}</h1>
          <div className="hero-sub">
            {book.chapters.length > 1 ? `${book.chapters.length} 章 · ` : ""}
            {book.storyCount} 剧情 · 已缓存 {cachedCount}/{book.storyCount}
          </div>
          <div className="hero-actions">
            <button className="sel-btn primary" disabled={busy} onClick={() => onDownloadBook(book)}>
              ⬇ 下载全部章节
            </button>
            <button
              className="sel-btn"
              onClick={() => onSetMany(book.pageTitles, !allSelected)}
            >
              {allSelected ? "✓ 全不选" : "全选章节"}
            </button>
            <button className="sel-btn danger" onClick={() => onDeleteBook(book)}>
              🗑 删除缓存
            </button>
          </div>
        </div>
      </div>

      <div className="detail-body">
        {book.chapters.map((ch, ci) => {
          const open = !collapsed[ci];
          const st = chapterState(ch);
          const titles = ch.stories.map((s) => s.page_title);
          const readCount = titles.filter((pt) => isRead(pt)).length;
          const chRead = readCount === titles.length; // whole chapter read
          return (
            <div key={ci} className={`detail-chapter ${chRead ? "read" : ""}`}>
              <div className="dc-head">
                <button
                  className={`dc-check ${st.all ? "on" : ""} ${st.some && !st.all ? "partial" : ""}`}
                  title={st.all ? "取消选择本章" : "选择本章"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetMany(titles, !st.all);
                  }}
                >
                  {st.all ? "✓" : st.some ? "–" : ""}
                </button>
                <button
                  className="dc-title"
                  onClick={() => setCollapsed((p) => ({ ...p, [ci]: !p[ci] }))}
                >
                  <span className={`arrow ${open ? "open" : ""}`}>▶</span>
                  <span className="dc-name">{ch.name}</span>
                  <span className="dc-count">
                    {readCount > 0 && !chRead ? `已读 ${readCount}/${ch.stories.length}` : `${ch.stories.length} 剧情`}
                  </span>
                  {chRead && <span className="dc-read-tag">已读</span>}
                </button>
              </div>

              {open && (
                <>
                  <RangeSelect chapter={ch} onApply={(pts) => onSetMany(pts, true)} />
                  <div className="dc-stories">
                    {ch.stories.map((s, si) => {
                      const on = selected.has(s.page_title);
                      const cached = isCached(s.page_title);
                      const read = isRead(s.page_title);
                      return (
                        <div key={si} className={`dc-story ${on ? "sel" : ""} ${read ? "read" : ""}`}>
                          <button
                            className={`dc-scheck ${on ? "on" : ""}`}
                            onClick={() => onToggleStory(s.page_title)}
                            title={on ? "取消选择" : "选择"}
                          >
                            {on ? "✓" : ""}
                          </button>
                          <span className={`dc-dot ${cached ? "cached" : ""}`} />
                          <span
                            className="dc-stitle"
                            onClick={() => onPlay(s.page_title)}
                            title={s.page_title}
                          >
                            {s.title}
                          </span>
                          {read && <span className="dc-read-tag">已读</span>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
