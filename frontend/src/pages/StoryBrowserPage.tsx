import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStoryIndex } from "../hooks/useStoryIndex";
import { useDownload } from "../lib/DownloadContext";
import { buildShelves } from "../lib/bookshelf";
import { getReadStories, getLastWatched } from "../lib/readState";
import type { Book, Shelf } from "../lib/bookshelf";
import CoverCard from "../components/CoverCard";
import ChapterDetail from "../components/ChapterDetail";
import SelectionBar from "../components/SelectionBar";
import { storylineIcon } from "../assets/storylines";

/**
 * Cinematic ebook bookshelf. Categories become shelf sections; chapters sharing
 * a cover key collapse into one CoverCard ("book"). Clicking a card drills into
 * an in-page ChapterDetail (no route push, so hardware-back stays here). A
 * persistent SelectionBar drives batch download/delete over selected stories.
 */
export default function StoryBrowserPage() {
  const { index, loading, error, refresh } = useStoryIndex();
  const [search, setSearch] = useState("");
  const [cachedStories, setCachedStories] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The drilled-in book lives in the URL (?cat=&book=) so it's its own history
  // entry: hardware/gesture back pops 章节 → 书架 (one level), and it survives the
  // player route's remount on return. A stub {category,coverKey} is enough —
  // `liveBook` resolves it to the full book from the (always-present) index.
  const openCategory = searchParams.get("cat");
  const openCover = searchParams.get("book");
  const openBook: Book | null = useMemo(
    () =>
      openCover
        ? ({ category: openCategory ?? "", coverKey: openCover, chapters: [], pageTitles: [], storyCount: 0 } as Book)
        : null,
    [openCategory, openCover]
  );
  // Drill into a book by pushing a history entry; back (hardware or ◀) pops it.
  const openBookCard = useCallback(
    (book: Book) => setSearchParams({ cat: book.category, book: book.coverKey }),
    [setSearchParams]
  );

  // On every drill in/out: clear any pending selection so the bottom bar doesn't
  // leak across pages (task 1). Returning to the shelf also scrolls the book we
  // just left back to the centre of the screen (task 6).
  const prevOpen = useRef<string | null>(openCover);
  useEffect(() => {
    const left = prevOpen.current;
    prevOpen.current = openCover;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(new Set());
    if (!openCover && left) {
      requestAnimationFrame(() => {
        const sel = `[data-cover="${left.replace(/["\\]/g, "\\$&")}"]`;
        document.querySelector(sel)?.scrollIntoView({ block: "center" });
      });
    }
  }, [openCover]);
  // Read stories + last-watched (refreshed on mount + window focus, i.e. on return
  // from the player).
  const [readStories, setReadStories] = useState<Set<string>>(() => getReadStories());
  const [lastWatched, setLastWatchedState] = useState<string | null>(() => getLastWatched());
  const { start: startPredownload, busy, status, onFinished } = useDownload();

  // Re-read read-state + last-watched whenever the window regains focus (e.g.
  // after the player route unmounts back to here).
  useEffect(() => {
    const refresh = () => {
      setReadStories(getReadStories());
      setLastWatchedState(getLastWatched());
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const refreshCached = useCallback(
    () =>
      invoke<string[]>("list_cached_stories")
        .then((list) => setCachedStories(new Set(list)))
        .catch(() => {}),
    []
  );

  // Load cached story list, and refresh it whenever a (global) download finishes.
  useEffect(() => {
    refreshCached();
    return onFinished(refreshCached);
  }, [onFinished, refreshCached]);

  // All shelves, then filtered by the search query (matches book title /
  // chapter / activity / story title / page_title).
  const shelves: Shelf[] = useMemo(() => (index ? buildShelves(index) : []), [index]);

  const filtered: Shelf[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shelves;
    return shelves
      .map((shelf) => ({
        category: shelf.category,
        books: shelf.books.filter((b) => {
          if (b.coverKey.toLowerCase().includes(q) || b.category.toLowerCase().includes(q)) {
            return true;
          }
          return b.chapters.some(
            (ch) =>
              ch.name.toLowerCase().includes(q) ||
              (ch.activity_name?.toLowerCase().includes(q) ?? false) ||
              ch.stories.some(
                (s) =>
                  s.title.toLowerCase().includes(q) || s.page_title.toLowerCase().includes(q)
              )
          );
        }),
      }))
      .filter((shelf) => shelf.books.length > 0);
  }, [shelves, search]);

  // Keep the drilled-in book in sync with a refreshed index (same coverKey).
  const liveBook: Book | null = useMemo(() => {
    if (!openBook) return null;
    for (const shelf of shelves) {
      const found = shelf.books.find(
        (b) => b.category === openBook.category && b.coverKey === openBook.coverKey
      );
      if (found) return found;
    }
    return openBook;
  }, [openBook, shelves]);

  // ----- selection helpers -----
  const toggleStory = (pt: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pt)) next.delete(pt);
      else next.add(pt);
      return next;
    });

  const setMany = (pts: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const pt of pts) {
        if (on) next.add(pt);
        else next.delete(pt);
      }
      return next;
    });

  const toggleBook = (book: Book) => {
    const allSel = book.pageTitles.every((pt) => selected.has(pt));
    setMany(book.pageTitles, !allSel);
  };

  const bookSelState = (book: Book): { selected: boolean; partial: boolean } => {
    const sel = book.pageTitles.filter((pt) => selected.has(pt)).length;
    return { selected: sel === book.pageTitles.length && sel > 0, partial: sel > 0 };
  };

  const clearSelection = () => setSelected(new Set());

  // Selection mode is on whenever something is selected; long-press enters it.
  const selectionMode = selected.size > 0;
  const enterSelect = (book: Book) => setMany(book.pageTitles, true);

  // Whole-category (shelf) select state + toggle.
  const shelfTitles = (shelf: Shelf) => shelf.books.flatMap((b) => b.pageTitles);
  const shelfSelState = (shelf: Shelf): { selected: boolean; partial: boolean } => {
    const pts = shelfTitles(shelf);
    const sel = pts.filter((pt) => selected.has(pt)).length;
    return { selected: sel === pts.length && sel > 0, partial: sel > 0 };
  };
  const toggleShelf = (shelf: Shelf) => {
    const pts = shelfTitles(shelf);
    setMany(pts, !pts.every((pt) => selected.has(pt)));
  };

  // ----- play / download / delete -----
  const playStory = (pageTitle: string) => navigate(`/play/${encodeURIComponent(pageTitle)}`);

  const fmtSize = (b: number): string =>
    b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;

  // Delete a set of stories' cache. The backend only removes assets exclusive to
  // these stories, so other cached chapters stay intact.
  const deleteTitles = async (titles: string[], label: string, after?: () => void) => {
    if (titles.length === 0) return;
    if (!confirm(`确认删除「${label}」的本地缓存？\n（仅删除其独有的资源，与其他章节共享的不受影响）`)) return;
    try {
      const r = await invoke<{ freedBytes: number; deletedFiles: number; storiesCleared: number }>(
        "delete_chapter_cache",
        { titles }
      );
      alert(`已清理「${label}」：${r.storiesCleared} 个剧情，释放 ${fmtSize(r.freedBytes)}`);
      refreshCached();
      after?.();
    } catch (e) {
      alert(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const batchDownload = () => startPredownload([...selected]);
  const batchDelete = () =>
    deleteTitles([...selected], `${selected.size} 个剧情`, clearSelection);

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
      {!liveBook && (
        <>
          <div className="browser-header">
            <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">
              ◀
            </button>
            <h1>剧情书架</h1>
            <input
              className="search-input"
              type="text"
              placeholder="搜索书目 / 剧情..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {/* Multi-select is entered by long-pressing a card; 全选/清空 live in
                the bottom selection bar. The index auto-refreshes in the
                background, so there's no manual refresh button. */}
          </div>

          <div className="browser-content shelf-content">
            {filtered.map((shelf) => (
              <section key={shelf.category} className="shelf">
                <div className="shelf-header">
                  {selectionMode && (() => {
                    const ss = shelfSelState(shelf);
                    return (
                      <button
                        className={`shelf-check ${ss.selected ? "on" : ""} ${ss.partial && !ss.selected ? "partial" : ""}`}
                        title={ss.selected ? "取消选择本类" : "选择本类全部"}
                        onClick={() => toggleShelf(shelf)}
                      >
                        {ss.selected ? "✓" : ss.partial ? "–" : ""}
                      </button>
                    );
                  })()}
                  {storylineIcon(shelf.category) && (
                    <img
                      className="shelf-icon"
                      src={storylineIcon(shelf.category)}
                      alt=""
                      aria-hidden="true"
                    />
                  )}
                  <span className="shelf-title">{shelf.category}</span>
                  <span className="shelf-count">{shelf.books.length} 章</span>
                </div>
                <div className="cover-grid">
                  {shelf.books.map((book) => {
                    const st = bookSelState(book);
                    return (
                      <CoverCard
                        key={book.coverKey}
                        book={book}
                        cachedStories={cachedStories}
                        readStories={readStories}
                        lastWatched={lastWatched}
                        selected={st.selected}
                        partial={st.partial && !st.selected}
                        selectionMode={selectionMode}
                        onOpen={openBookCard}
                        onToggleSelect={toggleBook}
                        onLongPress={enterSelect}
                      />
                    );
                  })}
                </div>
              </section>
            ))}

            {filtered.length === 0 && <div className="loading">未找到剧情</div>}
          </div>
        </>
      )}

      {liveBook && (
        <ChapterDetail
          book={liveBook}
          cachedStories={cachedStories}
          readStories={readStories}
          lastWatched={lastWatched}
          selected={selected}
          selectionMode={selectionMode}
          onBack={() => navigate(-1)}
          onPlay={playStory}
          onToggleStory={toggleStory}
          onSetMany={setMany}
        />
      )}

      <SelectionBar
        count={selected.size}
        busy={busy}
        downloadActive={status !== null}
        onClear={clearSelection}
        onDownload={batchDownload}
        onDelete={batchDelete}
      />
      {/* Progress is rendered globally by <DownloadBar> so it survives navigation. */}
    </div>
  );
}
