import { useMemo } from "react";
import type { Book } from "../lib/bookshelf";
import { cachedKey } from "../lib/bookshelf";
import { coverFallback, coverArt } from "../lib/cover";

interface Props {
  book: Book;
  cachedStories: Set<string>;
  /** True when every story in the book is selected. */
  selected: boolean;
  /** True when some (but not all) of the book's stories are selected. */
  partial: boolean;
  onOpen: (book: Book) => void;
  onToggleSelect: (book: Book) => void;
}

/**
 * One book's cinematic cover card. Renders real cover art when it loads,
 * otherwise a procedural filmic gradient seeded from the title. A bottom-left
 * title overlay (large CN + latin-ish subtitle) plus a cached indicator and a
 * card-level select checkbox (selects/clears the whole book) complete the card.
 */
export default function CoverCard({
  book,
  cachedStories,
  selected,
  partial,
  onOpen,
  onToggleSelect,
}: Props) {
  const fallback = useMemo(() => coverFallback(book.coverKey), [book.coverKey]);
  const art = useMemo(() => coverArt(book.coverKey), [book.coverKey]);

  const cachedCount = useMemo(
    () => book.pageTitles.filter((pt) => cachedStories.has(cachedKey(pt))).length,
    [book.pageTitles, cachedStories]
  );
  const allCached = cachedCount === book.storyCount && book.storyCount > 0;
  const pct = book.storyCount > 0 ? (cachedCount / book.storyCount) * 100 : 0;

  const subtitle =
    book.chapters.length > 1
      ? `${book.chapters.length} 章 · ${book.storyCount} 剧情`
      : `${book.storyCount} 剧情`;

  return (
    <div
      className={`cover-card ${selected ? "selected" : ""}`}
      onClick={() => onOpen(book)}
      role="button"
      tabIndex={0}
    >
      <div
        className="cover-art"
        style={{
          background: fallback.background,
          aspectRatio: art ? `${art.width} / ${art.height}` : "3 / 4",
        }}
      >
        {art && (
          <img className="cover-img" src={art.url} alt="" loading="lazy" draggable={false} />
        )}
        <div className="cover-scrim" />
        <div className="cover-meta">
          <div className="cover-title">{book.coverKey}</div>
          <div className="cover-sub">{subtitle}</div>
        </div>

        {/* Card-level multi-select: selects/clears all of the book's stories. */}
        <button
          className={`cover-check ${selected ? "on" : ""} ${partial ? "partial" : ""}`}
          title={selected ? "取消选择全部剧情" : "选择全部剧情"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(book);
          }}
        >
          {selected ? "✓" : partial ? "–" : ""}
        </button>

        {/* Cached indicator: a full pill when complete, else a thin ring/progress. */}
        <div className={`cover-cached ${allCached ? "done" : ""}`}>
          {allCached ? (
            "✓ 已缓存"
          ) : cachedCount > 0 ? (
            <>
              <span className="cover-ring" style={{ ["--p" as string]: `${pct}%` }} />
              {cachedCount}/{book.storyCount}
            </>
          ) : (
            <span className="cover-dim">未缓存</span>
          )}
        </div>
      </div>
    </div>
  );
}
