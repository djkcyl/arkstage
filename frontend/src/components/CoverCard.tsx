import { useEffect, useMemo, useState } from "react";
import type { Book } from "../lib/bookshelf";
import { cachedKey } from "../lib/bookshelf";
import { coverFallback } from "../lib/cover";
import { useBookshelfMetadata, type ResolvedArt } from "../lib/BookshelfMetadataContext";
import { useLongPress } from "../lib/useLongPress";

interface Props {
  book: Book;
  cachedStories: Set<string>;
  /** Story page-titles the user has read (for the green "all read" dot). */
  readStories: Set<string>;
  /** The last-watched story's page-title (badges the book that holds it). */
  lastWatched: string | null;
  /** True when every story in the book is selected. */
  selected: boolean;
  /** True when some (but not all) of the book's stories are selected. */
  partial: boolean;
  /** Multi-select mode (checkboxes shown). Entered by long-pressing any card. */
  selectionMode: boolean;
  onOpen: (book: Book) => void;
  onToggleSelect: (book: Book) => void;
  /** Long-press: enter selection mode and select this book. */
  onLongPress: (book: Book) => void;
}

/**
 * One book's cinematic cover card. Tap opens the book (or toggles it in selection
 * mode); long-press enters selection mode and selects it. A small cache dot
 * (hidden / yellow=partial / green=all) sits top-right; the select checkbox only
 * appears in selection mode.
 */
export default function CoverCard({
  book,
  cachedStories,
  readStories,
  lastWatched,
  selected,
  partial,
  selectionMode,
  onOpen,
  onToggleSelect,
  onLongPress,
}: Props) {
  const isLastWatched = !!lastWatched && book.pageTitles.includes(lastWatched);
  const fallback = coverFallback();
  const { metadata, resolveArt } = useBookshelfMetadata();
  const [art, setArt] = useState<ResolvedArt | null>(null);
  useEffect(() => {
    let alive = true;
    void resolveArt("covers", book.coverKey).then((next) => {
      if (alive) setArt(next);
    });
    return () => {
      alive = false;
    };
  }, [book.coverKey, metadata?.version, resolveArt]);
  const ratio = art ? art.width / art.height : 0;
  // Wide 联动 + 集成战略/生息演算 导引图 banners (ratio ≈ 3) keep their own wide
  // shape; every other card is a uniform square (为了明日's 1:1) with the art
  // center-cropped to fill. Empty cards are square too.
  const isBanner = !!art && ratio >= 2;
  // Only the square main-story kvs (反常光谱…) carry a large baked-in title, so
  // they alone drop the text overlay.
  const titleBaked = !!art && ratio >= 0.95 && ratio <= 1.05;

  const cachedCount = useMemo(
    () => book.pageTitles.filter((pt) => cachedStories.has(cachedKey(pt))).length,
    [book.pageTitles, cachedStories]
  );
  const readCount = useMemo(
    () => book.pageTitles.filter((pt) => readStories.has(pt)).length,
    [book.pageTitles, readStories]
  );
  const n = book.storyCount;
  // Status dot: none / yellow=partly downloaded / blue=all downloaded / green=all read.
  const dotClass =
    n > 0 && readCount === n
      ? "read"
      : n > 0 && cachedCount === n
        ? "all"
        : cachedCount > 0
          ? "partial"
          : "";

  const subtitle =
    book.chapters.length > 1
      ? `${book.chapters.length} 章 · ${book.storyCount} 剧情`
      : `${book.storyCount} 剧情`;

  const press = useLongPress(
    () => onLongPress(book),
    () => (selectionMode ? onToggleSelect(book) : onOpen(book))
  );

  return (
    <div
      className={`cover-card ${selected ? "selected" : ""}`}
      data-cover={book.coverKey}
      role="button"
      tabIndex={0}
      {...press}
    >
      <div
        className="cover-art"
        style={{
          background: fallback.background,
          aspectRatio: isBanner && art ? `${art.width} / ${art.height}` : "1 / 1",
        }}
      >
        {art ? (
          <img
            className="cover-img"
            src={art.url}
            data-fallback={art.fallbackUrl}
            onError={(event) => {
              const fallbackUrl = event.currentTarget.dataset.fallback;
              if (!fallbackUrl) {
                setArt(null);
                return;
              }
              delete event.currentTarget.dataset.fallback;
              event.currentTarget.src = fallbackUrl;
            }}
            alt=""
            loading="lazy"
            draggable={false}
          />
        ) : (
          <img className="cover-ph" src="/logo.png" alt="" aria-hidden="true" draggable={false} />
        )}
        <div className="cover-scrim" />
        <div className="cover-meta">
          {!titleBaked && <div className="cover-title">{book.coverKey}</div>}
          <div className="cover-sub">{subtitle}</div>
        </div>

        {/* Card-level multi-select (only in selection mode): selects/clears the book. */}
        {selectionMode && (
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
        )}

        {/* Cache dot: hidden / yellow (partial) / green (all). */}
        {dotClass && <span className={`cover-dot ${dotClass}`} />}

        {/* "Last watched" ribbon — points the user back to where they left off. */}
        {isLastWatched && !selectionMode && <span className="cover-last">上次观看</span>}
      </div>
    </div>
  );
}
