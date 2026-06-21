import { getSource } from "./source";
import type { SourceConfig } from "./source";

// ---------------------------------------------------------------------------
// Cover art + procedural cinematic fallback helpers for the bookshelf.
//
// Real cover art lives at covers/<sanitized>.jpg in the asset repo and is
// fetched directly over jsDelivr. The covers/ dir is currently empty, so the
// CoverCard renders a procedural gradient seeded from the title (hash → hue)
// whenever the <img> fails to load. The gradient is intentional, not a
// placeholder — varied per book so the shelf reads as distinct cinematic cards.
// ---------------------------------------------------------------------------

/** Sanitize a cover key the same way the backend does (`/\:*?"<>|` → `_`). */
export function sanitizeCoverKey(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "_");
}

/** Build the jsDelivr cover URL for a book's cover key. */
export function coverUrl(src: SourceConfig, coverKey: string): string {
  return `https://cdn.jsdelivr.net/gh/${src.jsdRepo}@${src.jsdRef}/covers/${sanitizeCoverKey(coverKey)}.jpg`;
}

/** Convenience: resolve the active source then build the URL. */
export async function resolveCoverUrl(coverKey: string): Promise<string> {
  const src = await getSource();
  return coverUrl(src, coverKey);
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
