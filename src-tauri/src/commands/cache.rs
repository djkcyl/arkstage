use std::path::{Path, PathBuf};

use crate::models::CacheStatus;

/// Get the cache directory path (under the configurable data root).
fn cache_dir() -> Result<PathBuf, String> {
    let cache_dir = crate::data_root::data_root().join("cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    Ok(cache_dir)
}

/// Every on-disk location the app caches into, under the data root:
///   - `cache/`  — story scripts, the index, manifests (small JSON)
///   - `assets/` — engine deps + font
///   - `media/`  — the content-addressed store of downloaded images/audio (the big one)
/// The displayed "cache size" and "clear all" must cover ALL of these, not just
/// `cache/` — otherwise the size reads ~20 MB while `media/` holds gigabytes.
fn all_cache_roots() -> Vec<PathBuf> {
    let root = crate::data_root::data_root();
    vec![root.join("cache"), root.join("assets"), root.join("media")]
}

/// Save JSON data to a cache file.
#[tauri::command]
pub async fn save_to_cache(key: String, data: String) -> Result<(), String> {
    let dir = cache_dir()?;
    // Sanitize key for filesystem
    let filename = sanitize_filename(&key);
    let path = dir.join(format!("{}.json", filename));
    recover_previous(&path);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    atomic_replace(&path, data.as_bytes())
        .map_err(|e| format!("Failed to write cache file: {}", e))?;

    Ok(())
}

fn recover_previous(path: &Path) {
    let backup = path.with_extension("previous");
    if !path.exists() && backup.exists() {
        let _ = std::fs::rename(backup, path);
    }
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("new-{}", std::process::id()));
    let backup = path.with_extension("previous");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&backup);
    let had_old = path.exists();
    if had_old {
        std::fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(&tmp, path) {
        if had_old {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    let _ = std::fs::remove_file(backup);
    Ok(())
}

/// Load cached data by key.
#[tauri::command]
pub async fn load_from_cache(key: String) -> Result<Option<String>, String> {
    let dir = cache_dir()?;
    let filename = sanitize_filename(&key);
    let path = dir.join(format!("{}.json", filename));
    recover_previous(&path);

    if path.exists() {
        let data = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read cache file: {}", e))?;
        Ok(Some(data))
    } else {
        Ok(None)
    }
}

/// Delete a cached item by key.
#[tauri::command]
pub async fn delete_from_cache(key: String) -> Result<(), String> {
    let dir = cache_dir()?;
    let filename = sanitize_filename(&key);
    let path = dir.join(format!("{}.json", filename));

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete cache file: {}", e))?;
    }
    Ok(())
}

/// List all cached story script keys.
#[tauri::command]
pub async fn list_cached_stories() -> Result<Vec<String>, String> {
    let dir = cache_dir()?;
    Ok(list_story_keys(&dir))
}

/// List cache keys for stored stories. Stories are saved as flat files named
/// `stories_*.json` (the `/` in the key is sanitized to `_`), so we scan by prefix.
fn list_story_keys(cache_dir: &std::path::Path) -> Vec<String> {
    let mut keys = Vec::new();
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("stories_") && name.ends_with(".json") {
                    keys.push(name.trim_end_matches(".json").to_string());
                }
            }
        }
    }
    keys
}

/// Get cache status information.
#[tauri::command]
pub async fn get_cache_status() -> Result<CacheStatus, String> {
    let dir = cache_dir()?;

    let story_index_cached = dir.join("story-index.json").exists();
    let asset_db_cached = dir.join("asset-databases.json").exists();
    let cached_stories = list_story_keys(&dir);
    // Sum cache/ + assets/ + media/ so the figure matches real disk usage (the
    // downloaded media store is by far the largest part).
    let total_size_bytes = all_cache_roots().iter().map(dir_size).sum();

    Ok(CacheStatus {
        story_index_cached,
        asset_db_cached,
        cached_stories,
        total_size_bytes,
    })
}

/// Clear ALL cached data — story cache, engine assets, AND the downloaded media
/// store (so "清除所有缓存" actually frees the gigabytes the media store holds, not
/// just the small JSON cache).
#[tauri::command]
pub async fn clear_cache() -> Result<(), String> {
    for dir in all_cache_roots() {
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("Failed to clear {}: {}", dir.display(), e))?;
        }
    }
    // Recreate the cache dir so subsequent writes don't race on a missing parent.
    cache_dir()?;
    Ok(())
}

/// Result of a per-chapter cache deletion.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub freed_bytes: u64,
    pub deleted_files: u64,
    pub stories_cleared: u64,
}

/// Delete the cache for a specific set of stories (a chapter/category) instead of
/// everything. Because the media store is content-addressed and DEDUPED across
/// stories, this only removes media assets used EXCLUSIVELY by the given stories —
/// anything still referenced by another cached story is kept, so deleting one
/// chapter never breaks another. Also removes those stories' per-story cache files
/// (manifest + script).
#[tauri::command]
pub async fn delete_chapter_cache(titles: Vec<String>) -> Result<DeleteResult, String> {
    Ok(delete_chapter_cache_in(
        &crate::data_root::data_root(),
        &titles,
    ))
}

/// Core of [`delete_chapter_cache`], parameterized on the data root for testing.
fn delete_chapter_cache_in(root: &Path, titles: &[String]) -> DeleteResult {
    use std::collections::HashSet;

    let cache = root.join("cache");
    let media_root = crate::media::media_root(root);

    // Manifest filenames of the stories being deleted.
    let del_keys: HashSet<String> = titles.iter().map(|t| manifest_filename(t)).collect();

    // Partition every cached manifest's URLs: ones belonging to the deleted stories
    // vs. ones still referenced by stories we're keeping (so shared assets survive).
    let mut del_urls: HashSet<String> = HashSet::new();
    let mut keep_urls: HashSet<String> = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("manifest_") && name.ends_with(".json")) {
                continue;
            }
            let Ok(s) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Some(urls) = parse_manifest_urls(&s) else {
                continue;
            };
            let target = if del_keys.contains(&name) {
                &mut del_urls
            } else {
                &mut keep_urls
            };
            target.extend(urls);
        }
    }

    let mut freed: u64 = 0;
    let mut deleted_files: u64 = 0;

    // Remove media assets exclusive to the deleted stories.
    for url in del_urls.difference(&keep_urls) {
        if let Some(p) = crate::media::store_path(&media_root, url) {
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.is_file() {
                    let len = meta.len();
                    if std::fs::remove_file(&p).is_ok() {
                        freed += len;
                        deleted_files += 1;
                    }
                }
            }
        }
    }

    // Remove the per-story cache files (manifest + script + atomic runtime snapshot).
    let mut stories_cleared: u64 = 0;
    for t in titles {
        let mut any = false;
        for f in [
            manifest_filename(t),
            story_filename(t),
            runtime_filename(t, 3, false),
            runtime_filename(t, 4, false),
            runtime_filename(t, 5, false),
            runtime_filename(t, 5, true),
        ] {
            let path = cache.join(f);
            if let Ok(meta) = std::fs::metadata(&path) {
                freed += meta.len();
                if std::fs::remove_file(&path).is_ok() {
                    deleted_files += 1;
                    any = true;
                }
            }
        }
        if any {
            stories_cleared += 1;
        }
    }

    DeleteResult {
        freed_bytes: freed,
        deleted_files,
        stories_cleared,
    }
}

fn parse_manifest_urls(s: &str) -> Option<Vec<String>> {
    if let Ok(urls) = serde_json::from_str::<Vec<String>>(s) {
        return Some(urls);
    }
    serde_json::from_str::<serde_json::Value>(s)
        .ok()?
        .get("urls")?
        .as_array()
        .map(|urls| {
            urls.iter()
                .filter_map(|u| u.as_str().map(str::to_string))
                .collect()
        })
}

fn dir_size(path: &PathBuf) -> u64 {
    if !path.exists() {
        return 0;
    }

    let mut size = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata();
            if let Ok(meta) = meta {
                if meta.is_file() {
                    size += meta.len();
                } else if meta.is_dir() {
                    size += dir_size(&entry.path());
                }
            }
        }
    }
    size
}

/// Sanitize a string for use as a filename.
/// Filesystem path of a story's cached manifest (the captured asset-URL list), or
/// None if the data root is unavailable. Mirrors the frontend key
/// `manifest_<title with / → _>` (sanitize_filename also maps `/`→`_`, so applying
/// it to `manifest_<title>` yields the identical name). Used by the Rust-side
/// cached-manifest feeder so the download can be driven without the WebView.
pub(crate) fn manifest_cache_path(title: &str) -> std::path::PathBuf {
    crate::data_root::data_root()
        .join("cache")
        .join(manifest_filename(title))
}

/// Cache filename (`<sanitized>.json`) for a story's captured manifest / script.
fn manifest_filename(title: &str) -> String {
    format!("{}.json", sanitize_filename(&format!("manifest_{title}")))
}
fn story_filename(title: &str) -> String {
    format!("{}.json", sanitize_filename(&format!("stories_{title}")))
}
fn runtime_filename(title: &str, version: u8, previous: bool) -> String {
    let suffix = if previous { "-previous" } else { "" };
    format!(
        "{}.json",
        sanitize_filename(&format!("story-runtime-v{version}_{title}{suffix}"))
    )
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_flat_story_files_by_prefix() {
        let tmp = std::env::temp_dir().join(format!("prts_cache_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("stories_W2G_BEG.json"), "{}").unwrap();
        fs::write(tmp.join("stories_W2G_END.json"), "{}").unwrap();
        fs::write(tmp.join("story-index.json"), "{}").unwrap();

        let mut got = list_story_keys(&tmp);
        got.sort();
        assert_eq!(
            got,
            vec!["stories_W2G_BEG".to_string(), "stories_W2G_END".to_string()]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn delete_chapter_keeps_shared_assets() {
        // Two stories: A and B share `shared.png`; A also has `onlyA.png`, B `onlyB.png`.
        // Deleting A must remove onlyA (exclusive) but KEEP shared (still used by B)
        // and onlyB — and remove A's manifest/script files only.
        let root = std::env::temp_dir().join(format!("prts_del_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let cache = root.join("cache");
        let media = crate::media::media_root(&root);
        fs::create_dir_all(&cache).unwrap();

        let shared = "https://media.prts.wiki/a/aa/shared.png";
        let only_a = "https://media.prts.wiki/b/bb/onlyA.png";
        let only_b = "https://media.prts.wiki/c/cc/onlyB.png";
        for u in [shared, only_a, only_b] {
            crate::media::write_local(&media, u, b"x").unwrap();
        }
        fs::write(
            cache.join(manifest_filename("Ch/A")),
            serde_json::to_string(&[shared, only_a]).unwrap(),
        )
        .unwrap();
        fs::write(cache.join(story_filename("Ch/A")), "{}").unwrap();
        for path in [
            runtime_filename("Ch/A", 3, false),
            runtime_filename("Ch/A", 4, false),
            runtime_filename("Ch/A", 5, false),
            runtime_filename("Ch/A", 5, true),
        ] {
            fs::write(cache.join(path), "{}").unwrap();
        }
        fs::write(
            cache.join(manifest_filename("Ch/B")),
            serde_json::to_string(&[shared, only_b]).unwrap(),
        )
        .unwrap();
        fs::write(cache.join(story_filename("Ch/B")), "{}").unwrap();

        let r = delete_chapter_cache_in(&root, &["Ch/A".to_string()]);

        // onlyA media gone; shared + onlyB kept.
        assert!(crate::media::store_path(&media, only_a).unwrap().exists() == false);
        assert!(crate::media::store_path(&media, shared).unwrap().exists());
        assert!(crate::media::store_path(&media, only_b).unwrap().exists());
        // A's cache files gone; B's kept.
        assert!(!cache.join(manifest_filename("Ch/A")).exists());
        assert!(!cache.join(story_filename("Ch/A")).exists());
        assert!(!cache.join(runtime_filename("Ch/A", 5, false)).exists());
        assert!(!cache.join(runtime_filename("Ch/A", 5, true)).exists());
        assert!(cache.join(manifest_filename("Ch/B")).exists());
        // 1 media + manifest + script + four runtime generations.
        assert_eq!(r.deleted_files, 7);
        assert_eq!(r.stories_cleared, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parses_versioned_manifest_urls() {
        let json = r#"{"schemaVersion":2,"urls":["https://media.prts.wiki/a/a.png"]}"#;
        assert_eq!(
            parse_manifest_urls(json).unwrap(),
            vec!["https://media.prts.wiki/a/a.png"]
        );
    }
}
