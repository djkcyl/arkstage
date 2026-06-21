import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStoryIndex } from "../hooks/useStoryIndex";
import { useDownload } from "../lib/DownloadContext";
import { getSource } from "../lib/source";
import type { SourceConfig } from "../lib/source";
import { coverUrl } from "../lib/cover";
import { buildShelves } from "../lib/bookshelf";
import type { Book, Shelf } from "../lib/bookshelf";
import CoverCard from "../components/CoverCard";
import ChapterDetail from "../components/ChapterDetail";
import SelectionBar from "../components/SelectionBar";

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
  const [openBook, setOpenBook] = useState<Book | null>(null);
  const [source, setSource] = useState<SourceConfig | null>(null);
  const { start: startPredownload, busy, status, onFinished } = useDownload();
  const navigate = useNavigate();

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

  // Resolve the asset source once so we can build cover URLs.
  useEffect(() => {
    getSource()
      .then(setSource)
      .catch(() => {});
  }, []);

  const urlFor = useCallback(
    (coverKey: string): string | null => (source ? coverUrl(source, coverKey) : null),
    [source]
  );

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

  const selectAllVisible = () => {
    const all: string[] = [];
    if (liveBook) all.push(...liveBook.pageTitles);
    else for (const shelf of filtered) for (const b of shelf.books) all.push(...b.pageTitles);
    setSelected(new Set(all));
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

  const downloadBook = (book: Book) => startPredownload(book.pageTitles);
  const deleteBook = (book: Book) => deleteTitles(book.pageTitles, book.coverKey);

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
            <button className="nav-btn" onClick={() => navigate("/")}>
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
            <button className="nav-btn" onClick={refresh} title="刷新">
              ↻
            </button>
          </div>

          <div className="browser-content shelf-content">
            {filtered.map((shelf) => (
              <section key={shelf.category} className="shelf">
                <div className="shelf-header">
                  <span className="shelf-title">{shelf.category}</span>
                  <span className="shelf-count">{shelf.books.length} 本</span>
                </div>
                <div className="cover-grid">
                  {shelf.books.map((book) => {
                    const st = bookSelState(book);
                    return (
                      <CoverCard
                        key={book.coverKey}
                        book={book}
                        coverUrl={urlFor(book.coverKey)}
                        cachedStories={cachedStories}
                        selected={st.selected}
                        partial={st.partial && !st.selected}
                        onOpen={setOpenBook}
                        onToggleSelect={toggleBook}
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
          coverUrl={urlFor(liveBook.coverKey)}
          cachedStories={cachedStories}
          selected={selected}
          busy={busy}
          onBack={() => setOpenBook(null)}
          onPlay={playStory}
          onToggleStory={toggleStory}
          onSetMany={setMany}
          onDownloadBook={downloadBook}
          onDeleteBook={deleteBook}
        />
      )}

      <SelectionBar
        count={selected.size}
        busy={busy}
        downloadActive={status !== null}
        onSelectAll={selectAllVisible}
        onClear={clearSelection}
        onDownload={batchDownload}
        onDelete={batchDelete}
      />
      {/* Progress is rendered globally by <DownloadBar> so it survives navigation. */}
    </div>
  );
}
