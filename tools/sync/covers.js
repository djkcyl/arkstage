// Cover-art discovery — extension point. The cover-art source is being researched
// separately; do NOT block the spike on it.

/**
 * Discover a cover-art URL/key for a given activity.
 * @param {string} _activityName the activity/zone name from the parsed index
 * @returns {Promise<string | null>} a canonical key or URL, or null if none
 */
export async function discoverCover(_activityName) {
  // TODO(phase2-covers): the cover-art source is still being researched. Candidates:
  //   - the activity's wiki page banner/logo image
  //   - the 活动一览 / event-list page thumbnails
  // Once decided, fetch + canonicalKey() the cover, return its key so sync.js can
  // download it like any other media and record it in index.json per-activity.
  return null;
}
