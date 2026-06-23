import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useCallback } from "react";
import { regroupStoryIndex } from "../lib/storylines";

export interface StoryIndex {
  categories: StoryCategory[];
}

export interface StoryCategory {
  name: string;
  chapters: StoryChapter[];
}

export interface StoryChapter {
  name: string;
  /** Broader activity/zone the chapter belongs to (e.g. "黑暗时代·上", "集成战略"). */
  activity_name?: string | null;
  stories: StoryEntry[];
}

export interface StoryEntry {
  title: string;
  page_title: string;
}

/**
 * Fetch story index with cache-first strategy.
 */
export function useStoryIndex() {
  const [index, setIndex] = useState<StoryIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIndex = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Try cache first
      const cached = await invoke<string | null>("load_from_cache", {
        key: "story-index",
      });

      if (cached) {
        const parsed = JSON.parse(cached) as StoryIndex;
        setIndex(regroupStoryIndex(parsed));
        setLoading(false);

        // Refresh in background
        refreshIndex(setIndex).catch(() => {});
        return;
      }

      // No cache — fetch from prts.wiki (the index is no longer bundled). On the
      // first launch this needs a network connection; the error path offers retry.
      await refreshIndex(setIndex);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIndex();
  }, [fetchIndex]);

  return { index, loading, error, refresh: fetchIndex };
}

async function refreshIndex(
  setIndex: (idx: StoryIndex) => void
): Promise<void> {
  const fresh = await invoke<StoryIndex>("fetch_story_index");
  setIndex(regroupStoryIndex(fresh));

  // Cache the raw fresh index; regrouping is applied on read.
  await invoke("save_to_cache", {
    key: "story-index",
    data: JSON.stringify(fresh),
  });
}
