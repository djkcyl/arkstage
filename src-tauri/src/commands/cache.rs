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
    let stories_dir = dir.join("stories");

    if !stories_dir.exists() {
        return Ok(Vec::new());
    }

    let mut stories = Vec::new();
    let entries = std::fs::read_dir(&stories_dir)
        .map_err(|e| format!("Failed to read stories dir: {}", e))?;

    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.ends_with(".json") {
                stories.push(name.trim_end_matches(".json").to_string());
            }
        }
    }

    Ok(stories)
}

/// Get cache status information.
#[tauri::command]
pub async fn get_cache_status(app: AppHandle) -> Result<CacheStatus, String> {
    let dir = cache_dir(&app)?;

    let story_index_cached = dir.join("story-index.json").exists();
    let asset_db_cached = dir.join("asset-databases.json").exists();
    let cached_stories = list_cached_stories_internal(&dir);
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

fn list_cached_stories_internal(cache_dir: &PathBuf) -> Vec<String> {
    let stories_dir = cache_dir.join("stories");
    if !stories_dir.exists() {
        return Vec::new();
    }

    let mut stories = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&stories_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".json") {
                    stories.push(name.trim_end_matches(".json").to_string());
                }
            }
        }
    }
    stories
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
