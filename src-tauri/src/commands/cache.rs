use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::models::CacheStatus;

/// Get the cache directory path.
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let cache_dir = dir.join("cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    Ok(cache_dir)
}

/// Save JSON data to a cache file.
#[tauri::command]
pub async fn save_to_cache(
    key: String,
    data: String,
    app: AppHandle,
) -> Result<(), String> {
    let dir = cache_dir(&app)?;
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
    app: AppHandle,
) -> Result<Option<String>, String> {
    let dir = cache_dir(&app)?;
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
    app: AppHandle,
) -> Result<(), String> {
    let dir = cache_dir(&app)?;
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
pub async fn list_cached_stories(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = cache_dir(&app)?;
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
pub async fn get_cache_status(app: AppHandle) -> Result<CacheStatus, String> {
    let dir = cache_dir(&app)?;

    let story_index_cached = dir.join("story-index.json").exists();
    let asset_db_cached = dir.join("asset-databases.json").exists();
    let cached_stories = list_story_keys(&dir);
    let total_size_bytes = dir_size(&dir);

    Ok(CacheStatus {
        story_index_cached,
        asset_db_cached,
        cached_stories,
        total_size_bytes,
    })
}

/// Clear all cached data.
#[tauri::command]
pub async fn clear_cache(app: AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to clear cache: {}", e))?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to recreate cache dir: {}", e))?;
    }
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
