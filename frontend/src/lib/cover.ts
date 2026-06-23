// ---------------------------------------------------------------------------
// Bookshelf covers, bundled per book and looked up by cover key. Two sources:
//   • in-game StoryLine ("mixstory") key visuals — square 432² main-story EPs +
//     wide ~632×456 activities (tools/extract-covers/extract-mixstory-kv.mjs);
//   • books with no StoryLine kv (联动 collab events + 集成战略/生息演算 modes)
//     use a prts banner (tools/extract-covers/extract-banner-covers.mjs).
// The two with neither (特殊/四月辑录) fall back to a flat panel with the app
// logo as a placeholder (coverFallback + CoverCard).
// ---------------------------------------------------------------------------
import coverDims from "../data/cover-dims.json";

// Bundled cover images, keyed by file basename = sanitize(coverKey).
const COVER_URLS = import.meta.glob("../assets/covers/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const COVER_BY_KEY: Record<string, string> = {};
for (const [p, url] of Object.entries(COVER_URLS)) {
  const base = p.slice(p.lastIndexOf("/") + 1).replace(/\.webp$/, "");
  COVER_BY_KEY[base] = url;
}
const DIMS = coverDims as Record<string, number[]>;

/** Match bundle-covers.mjs / extract-storyentry.mjs sanitize (filesystem-safe). */
function sanitizeCoverKey(key: string): string {
  return key.replace(/[/\\:*?"<>|]/g, "_");
}

export interface CoverArt {
  url: string;
  width: number;
  height: number;
}

/** Bundled cover art for a book's cover key, or null if none exists. */
export function coverArt(coverKey: string): CoverArt | null {
  const k = sanitizeCoverKey(coverKey);
  const url = COVER_BY_KEY[k];
  if (!url) return null;
  const d = DIMS[k];
  const width = d?.[0] ?? 3;
  const height = d?.[1] ?? 4;
  return { url, width, height };
}

// Chapter-detail top banners (活动预告图), keyed like covers. Shown behind the
// ChapterDetail hero with a bottom fade. Not every book has one (early main EPs).
const BANNER_URLS = import.meta.glob("../assets/banners/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const BANNER_BY_KEY: Record<string, string> = {};
for (const [p, url] of Object.entries(BANNER_URLS)) {
  BANNER_BY_KEY[p.slice(p.lastIndexOf("/") + 1).replace(/\.webp$/, "")] = url;
}

/** Bundled chapter banner URL for a book's cover key, or null if none. */
export function bannerArt(coverKey: string): string | null {
  return BANNER_BY_KEY[sanitizeCoverKey(coverKey)] ?? null;
}

export interface CoverFallback {
  /** Inline background for an empty-cover card. */
  background: string;
}

/**
 * Empty-cover card for books with no bundled image (特殊 / 四月辑录). A flat dark
 * panel — the old per-title color gradient was dropped on request; CoverCard
 * overlays the app logo as the placeholder mark on top of this.
 */
export function coverFallback(): CoverFallback {
  return { background: "#181a20" };
}
