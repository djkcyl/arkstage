// Regroup a story index into the in-game 主题曲/回想 StoryLine taxonomy (14 篇章
// + 特殊&未分类), applied at runtime so BOTH the cached baseline and prts-refreshed
// index (parsed by the Rust side into the plain 主线/活动 structure) come out
// grouped the same way. Membership arrives from the runtime `resources` branch.
// Books are matched by their cover key
// (activity_name ?? name); anything unlisted collects into 特殊&未分类.
import type { StoryIndex, StoryChapter } from "../hooks/useStoryIndex";

const SPECIAL = "特殊&未分类";

function bookKey(ch: StoryChapter): string {
  return (ch.activity_name ?? ch.name) || ch.name;
}

/** Re-bucket all chapters into StoryLine categories (idempotent). */
export function regroupStoryIndex(
  index: StoryIndex,
  storylines: [string, string[]][],
  fallbackCategory = SPECIAL
): StoryIndex {
  const all = index.categories.flatMap((c) => c.chapters);
  const used = new Set<StoryChapter>();
  const categories: StoryIndex["categories"] = [];

  for (const [line, acts] of storylines) {
    const chapters: StoryChapter[] = [];
    for (const act of acts) {
      for (const ch of all) {
        if (bookKey(ch) === act) {
          chapters.push(ch);
          used.add(ch);
        }
      }
    }
    if (chapters.length) categories.push({ name: line, chapters });
  }

  const special = all.filter((ch) => !used.has(ch));
  if (special.length) categories.push({ name: fallbackCategory, chapters: special });

  return { categories };
}
