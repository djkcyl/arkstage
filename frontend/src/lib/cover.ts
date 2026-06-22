// ---------------------------------------------------------------------------
// Bookshelf covers. Real 剧情一览 cover art (storyEntryPic, transparent cutouts)
// is bundled per book and looked up by cover key; books without one (主线 EPs,
// special modes) fall back to a procedural filmic gradient seeded from the title.
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

/** Stable 32-bit hash of a string (FNV-1a) for seeding the gradient. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface CoverFallback {
  /** Inline background for the procedural cinematic card. */
  background: string;
  /** Base hue (0–360) for accent tinting. */
  hue: number;
}

/**
 * Build a rich, filmic dark gradient seeded from the title. Two hues a short
 * arc apart give a duotone sweep; a vignette + a faint highlight keep it from
 * looking flat. Kept dark so overlaid gold title typography stays legible.
 */
export function coverFallback(title: string): CoverFallback {
  const h = hash(title);
  const hue = h % 360;
  const hue2 = (hue + 28 + (h % 40)) % 360;
  const a = `hsl(${hue}, 42%, 22%)`;
  const b = `hsl(${hue2}, 38%, 12%)`;
  const c = `hsl(${(hue + 180) % 360}, 30%, 8%)`;
  const background = [
    // soft top-left key light
    `radial-gradient(120% 90% at 18% 8%, ${a} 0%, transparent 55%)`,
    // vignette toward bottom-right
    `radial-gradient(140% 120% at 100% 100%, ${c} 0%, transparent 60%)`,
    // base duotone sweep
    `linear-gradient(135deg, ${b} 0%, ${c} 100%)`,
  ].join(", ");
  return { background, hue };
}
