use std::path::PathBuf;

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
pub async fn save_to_cache(
    key: String,
    data: String,
) -> Result<(), String> {
    let dir = cache_dir()?;
    // Sanitize key for filesystem
    let filename = sanitize_filename(&key);
    let path = dir.join(format!("{}.json", filename));

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to write cache file: {}", e))?;

    Ok(())
}

/// Load cached data by key.
#[tauri::command]
pub async fn load_from_cache(
    key: String,
) -> Result<Option<String>, String> {
    let dir = cache_dir()?;
    let filename = sanitize_filename(&key);
    let path = dir.join(format!("{}.json", filename));

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
pub async fn delete_from_cache(
    key: String,
) -> Result<(), String> {
    let dir = cache_dir()?;
    let filename = sanitize_filename(&key);
    let path = dir.join(format!("{}.json", filename));

    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete cache file: {}", e))?;
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
}
