import { useEffect, useState, useMemo } from "react";
import type { Book } from "../lib/bookshelf";
import { cachedKey } from "../lib/bookshelf";
import { coverFallback } from "../lib/cover";
import { useBookshelfMetadata } from "../lib/BookshelfMetadataContext";
import { useLongPress } from "../lib/useLongPress";
import type { StoryChapter } from "../hooks/useStoryIndex";

interface Props {
  book: Book;
  cachedStories: Set<string>;
  /** Story page-titles the user has opened in the player (read). */
  readStories: Set<string>;
  /** The last-watched story's page-title (tagged "上次观看" in the list). */
  lastWatched: string | null;
  /** Currently-selected story page-titles (shared across the detail view). */
  selected: Set<string>;
  /** Multi-select mode (checkboxes shown). Entered by long-pressing a story/chapter. */
  selectionMode: boolean;
  onBack: () => void;
  onPlay: (pageTitle: string) => void;
  /** Toggle one story's selection. */
  onToggleStory: (pageTitle: string) => void;
  /** Add or remove a batch of page-titles (whole chapter). */
  onSetMany: (pageTitles: string[], on: boolean) => void;
}

/**
 * Drill-in view for one book: a hero header plus its chapters, each collapsible
 * and listing its stories. Long-press a story or chapter to enter selection mode
 * (then the bottom bar drives download/delete); tap a story to read it. A leading
 * dot shows state: grey (not cached) / yellow (cached) / green (read).
 */
export default function ChapterDetail({
  book,
  cachedStories,
  readStories,
  lastWatched,
  selected,
  selectionMode,
  onBack,
  onPlay,
  onToggleStory,
  onSetMany,
}: Props) {
  const fallback = coverFallback();
  const { metadata, resolveArt } = useBookshelfMetadata();
  const [banner, setBanner] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void resolveArt("banners", book.coverKey).then((art) => {
      if (alive) setBanner(art?.url ?? null);
    });
    return () => {
      alive = false;
    };
  }, [book.coverKey, metadata?.version, resolveArt]);
  // Default: all chapters open.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const isCached = (pt: string) => cachedStories.has(cachedKey(pt));
  const isRead = (pt: string) => readStories.has(pt);

  const cachedCount = useMemo(
    () => book.pageTitles.filter((pt) => cachedStories.has(cachedKey(pt))).length,
    [book.pageTitles, cachedStories]
  );

  const chapterState = (ch: StoryChapter): { all: boolean; some: boolean } => {
    const sel = ch.stories.filter((s) => selected.has(s.page_title)).length;
    return { all: sel === ch.stories.length && sel > 0, some: sel > 0 };
  };

  // Dot for one story: green=read, blue=downloaded, none otherwise (a single
  // story has no "partial", so no yellow).
  const storyDot = (pt: string) => (isRead(pt) ? "read" : isCached(pt) ? "all" : "");

  return (
    <div className="chapter-detail">
      <div className={`detail-hero ${banner ? "has-banner" : ""}`} style={{ background: fallback.background }}>
        {banner && <img className="hero-banner" src={banner} alt="" draggable={false} />}
        <div className="hero-scrim" />
        <button className="hero-back back-icon" onClick={onBack} aria-label="返回">
          ◀
        </button>
        <div className="hero-meta">
          <div className="hero-cat">{book.category}</div>
          <h1 className="hero-title">{book.coverKey}</h1>
          <div className="hero-sub">
            {book.chapters.length > 1 ? `${book.chapters.length} 章 · ` : ""}
            {book.storyCount} 剧情 · 已缓存 {cachedCount}/{book.storyCount}
          </div>
        </div>
      </div>

      <div className="detail-body">
        {book.chapters.map((ch, ci) => (
          <Chapter
            key={ci}
            chapter={ch}
            open={!collapsed[ci]}
            onToggleOpen={() => setCollapsed((p) => ({ ...p, [ci]: !p[ci] }))}
            selected={selected}
            lastWatched={lastWatched}
            selectionMode={selectionMode}
            chapterState={chapterState(ch)}
            isCached={isCached}
            isRead={isRead}
            storyDot={storyDot}
            onPlay={onPlay}
            onToggleStory={onToggleStory}
            onSetMany={onSetMany}
          />
        ))}
      </div>
    </div>
  );
}

function Chapter({
  chapter: ch,
  open,
  onToggleOpen,
  selected,
  lastWatched,
  selectionMode,
  chapterState: st,
  isCached,
  isRead,
  storyDot,
  onPlay,
  onToggleStory,
  onSetMany,
}: {
  chapter: StoryChapter;
  open: boolean;
  onToggleOpen: () => void;
  selected: Set<string>;
  lastWatched: string | null;
  selectionMode: boolean;
  chapterState: { all: boolean; some: boolean };
  isCached: (pt: string) => boolean;
  isRead: (pt: string) => boolean;
  storyDot: (pt: string) => string;
  onPlay: (pt: string) => void;
  onToggleStory: (pt: string) => void;
  onSetMany: (pts: string[], on: boolean) => void;
}) {
  const titles = ch.stories.map((s) => s.page_title);
  const readCount = titles.filter((pt) => isRead(pt)).length;
  const chRead = titles.length > 0 && readCount === titles.length;
  const cachedCount = titles.filter((pt) => isCached(pt)).length;
  // Chapter dot: green=all read, blue=all downloaded, yellow=partly downloaded, none otherwise.
  const chDot = chRead
    ? "read"
    : cachedCount === titles.length && titles.length > 0
      ? "all"
      : cachedCount > 0
        ? "partial"
        : "";

  // Long-press the chapter title → select the whole chapter; tap → collapse.
  const headPress = useLongPress(() => onSetMany(titles, true), onToggleOpen);

  return (
    <div className={`detail-chapter ${chRead ? "read" : ""}`}>
      <div className="dc-head">
        {selectionMode && (
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
        )}
        <span className={`dc-dot ${chDot}`} />
        <button className="dc-title" {...headPress}>
          <span className={`arrow ${open ? "open" : ""}`}>▶</span>
          <span className="dc-name">{ch.name}</span>
          <span className="dc-count">
            {readCount > 0 && !chRead ? `已读 ${readCount}/${ch.stories.length}` : `${ch.stories.length} 剧情`}
          </span>
        </button>
      </div>

      {open && (
        <div className="dc-stories">
          {ch.stories.map((s, si) => (
            <Story
              key={si}
              title={s.title}
              pageTitle={s.page_title}
              on={selected.has(s.page_title)}
              dot={storyDot(s.page_title)}
              isLast={s.page_title === lastWatched}
              selectionMode={selectionMode}
              onPlay={onPlay}
              onToggleStory={onToggleStory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Story({
  title,
  pageTitle,
  on,
  dot,
  isLast,
  selectionMode,
  onPlay,
  onToggleStory,
}: {
  title: string;
  pageTitle: string;
  on: boolean;
  dot: string;
  isLast: boolean;
  selectionMode: boolean;
  onPlay: (pt: string) => void;
  onToggleStory: (pt: string) => void;
}) {
  // Long-press → select; tap → toggle (in selection mode) or read.
  const press = useLongPress(
    () => onToggleStory(pageTitle),
    () => (selectionMode ? onToggleStory(pageTitle) : onPlay(pageTitle))
  );
  return (
    <div className={`dc-story ${on ? "sel" : ""} ${dot === "read" ? "read" : ""}`}>
      {selectionMode && (
        <button
          className={`dc-scheck ${on ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStory(pageTitle);
          }}
          title={on ? "取消选择" : "选择"}
        >
          {on ? "✓" : ""}
        </button>
      )}
      <span className={`dc-dot ${dot}`} />
      <span className="dc-stitle" title={pageTitle} {...press}>
        {title}
      </span>
      {isLast && <span className="dc-last-tag">上次观看</span>}
    </div>
  );
}
