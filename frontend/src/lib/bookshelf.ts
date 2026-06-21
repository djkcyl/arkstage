import type { StoryCategory, StoryChapter, StoryIndex } from "../hooks/useStoryIndex";

// ---------------------------------------------------------------------------
// Bookshelf model. A "book" groups every chapter in a category that shares the
// same cover key (`activity_name ?? name`) — e.g. 集成战略's two chapters
// collapse into one book, while a standalone chapter is its own book. Each book
// is one CoverCard; drilling in reveals its chapters and their stories.
// ---------------------------------------------------------------------------

export interface Book {
  /** Cover key = activity_name ?? first chapter name; also the display title. */
  coverKey: string;
  category: string;
  chapters: StoryChapter[];
  /** Flattened page-titles across all chapters (for batch download/delete). */
  pageTitles: string[];
  storyCount: number;
}

export interface Shelf {
  category: string;
  books: Book[];
}

/** Cache key for a story page-title (`/` → `_`), matching the backend keys. */
export function cachedKey(pageTitle: string): string {
  return `stories_${pageTitle.replace(/\//g, "_")}`;
}

/** Group a category's chapters into books by cover key, preserving order. */
function booksOf(cat: StoryCategory): Book[] {
  const order: string[] = [];
  const byKey = new Map<string, StoryChapter[]>();
  for (const ch of cat.chapters) {
    const key = (ch.activity_name ?? ch.name) || ch.name;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(ch);
  }
  return order.map((coverKey) => {
    const chapters = byKey.get(coverKey)!;
    const pageTitles = chapters.flatMap((ch) => ch.stories.map((s) => s.page_title));
    return {
      coverKey,
      category: cat.name,
      chapters,
      pageTitles,
      storyCount: pageTitles.length,
    };
  });
}

/** Build the full set of shelves (one per category) from the story index. */
export function buildShelves(index: StoryIndex): Shelf[] {
  return index.categories.map((cat) => ({ category: cat.name, books: booksOf(cat) }));
}
