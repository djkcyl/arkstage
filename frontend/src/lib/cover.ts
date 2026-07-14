// ---------------------------------------------------------------------------
// Bookshelf art is loaded by BookshelfMetadataContext from the standalone
// `resources` branch. This module only owns the no-art visual fallback.
// ---------------------------------------------------------------------------

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
