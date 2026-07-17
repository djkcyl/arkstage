use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Get the assets directory path (under the configurable data root).
fn assets_dir() -> Result<PathBuf, String> {
    let assets_dir = crate::data_root::data_root().join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets dir: {}", e))?;
    Ok(assets_dir)
}

/// Download an asset file (image/audio) and save it locally.
/// Returns the local file path.
#[tauri::command]
pub async fn download_asset(
    url: String,
    category: String,
    filename: String,
) -> Result<String, String> {
    let dir = assets_dir()?;
    let category_dir = dir.join(&category);
    std::fs::create_dir_all(&category_dir)
        .map_err(|e| format!("Failed to create category dir: {}", e))?;

    let path = category_dir.join(&filename);

    // Skip if already cached
    if path.exists() {
        return path
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "Invalid path".to_string());
    }

    // Offline gate: refuse to fetch a missing asset when networking is off.
    crate::net::ensure_online()?;
    let resp = crate::net::client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download asset: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading: {}", resp.status(), url));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read asset bytes: {}", e))?;

    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write asset file: {}", e))?;

    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSnapshot {
    pub path: String,
    pub sha256: String,
    /// False means the online refresh failed and a validated last-known-good file
    /// was retained. The caller may surface the warning without losing playback.
    pub fresh: bool,
    pub warning: Option<String>,
}

/// Fresh-first update for executable engine dependencies. New bytes are validated
/// and atomically replaced; a failed/HTML/truncated response can never overwrite
/// the previous working copy.
#[tauri::command]
pub async fn refresh_engine_asset(url: String, filename: String) -> Result<AssetSnapshot, String> {
    let dir = assets_dir()?.join("engine");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);
    recover_previous(&path);

    let cached = std::fs::read(&path)
        .ok()
        .filter(|bytes| validate_engine_asset(&filename, bytes).is_ok());
    if cached.is_none() && path.exists() {
        let _ = std::fs::remove_file(&path);
    }

    let refreshed = async {
        crate::net::ensure_online()?;
        let resp = crate::net::client()
            .get(&url)
            .header("Referer", "https://prts.wiki/")
            .send()
            .await
            .map_err(|e| format!("Failed to refresh {filename}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {} refreshing {url}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        validate_engine_asset(&filename, &bytes)?;
        atomic_write(&path, &bytes)?;
        Ok::<Vec<u8>, String>(bytes)
    }
    .await;

    let (bytes, fresh, warning) = match refreshed {
        Ok(bytes) => (bytes, true, None),
        Err(error) => match cached {
            Some(bytes) => (bytes, false, Some(error)),
            None => return Err(error),
        },
    };
    let path_string = path
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())?
        .to_string();
    Ok(AssetSnapshot {
        path: path_string,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        fresh,
        warning,
    })
}

fn validate_engine_asset(filename: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 64 {
        return Err(format!("{filename} is truncated ({} bytes)", bytes.len()));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| format!("{filename} is not UTF-8 text"))?;
    let lower = filename.to_ascii_lowercase();
    let valid = if lower.contains("jquery") {
        text.contains("jQuery")
    } else if lower.contains("preload") {
        text.contains("createjs") && text.contains("LoadQueue")
    } else if lower.contains("toolbox") {
        text.contains("TimerManager")
    } else if lower.ends_with(".css") {
        text.contains("#sys_main") || text.contains("#sys_fullscreen")
    } else {
        false
    };
    if !valid
        || text.trim_start().starts_with("<!DOCTYPE html")
        || text.contains("<title>Internal Server Error")
    {
        return Err(format!("{filename} failed engine integrity markers"));
    }
    Ok(())
}

fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("part-{}", std::process::id()));
    let backup = path.with_extension("previous");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&backup);
    let had_old = path.exists();
    if had_old {
        std::fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        if had_old {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    let _ = std::fs::remove_file(backup);
    Ok(())
}

fn recover_previous(path: &std::path::Path) {
    let backup = path.with_extension("previous");
    if !path.exists() && backup.exists() {
        let _ = std::fs::rename(backup, path);
    }
}

/// Check if an asset is cached locally and return its path.
#[tauri::command]
pub async fn get_asset_path(category: String, filename: String) -> Result<Option<String>, String> {
    let dir = assets_dir()?;
    let path = dir.join(&category).join(&filename);
    recover_previous(&path);

    if path.exists() {
        if category == "engine" {
            let valid = std::fs::read(&path)
                .ok()
                .is_some_and(|bytes| validate_engine_asset(&filename, &bytes).is_ok());
            if !valid {
                let _ = std::fs::remove_file(&path);
                return Ok(None);
            }
        }
        Ok(path.to_str().map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

/// Read a cached text asset and return its content as a string.
#[tauri::command]
pub async fn read_asset_text(category: String, filename: String) -> Result<Option<String>, String> {
    let dir = assets_dir()?;
    let path = dir.join(&category).join(&filename);
    recover_previous(&path);

    if path.exists() {
        if category == "engine" {
            let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read asset: {e}"))?;
            if validate_engine_asset(&filename, &bytes).is_err() {
                let _ = std::fs::remove_file(&path);
                return Ok(None);
            }
        }
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed to read asset: {}", e))
    } else {
        Ok(None)
    }
}
// Bulk media downloading moved to the managed `download` module (job model with
// concurrency, pause/resume, cancel, progress events, bandwidth limit). See
// `download_start` and friends; the old `batch_download_assets` was removed.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_integrity_rejects_html_and_accepts_expected_markers() {
        assert!(validate_engine_asset(
            "krliov.toolbox.js",
            b"class TimerManager { constructor() {} }                                             "
        )
        .is_ok());
        assert!(validate_engine_asset(
            "krliov.toolbox.js",
            b"<!DOCTYPE html><html><title>Internal Server Error</title></html>          "
        )
        .is_err());
    }

    /// Opt-in real network smoke test for the hot-update transport.
    #[tokio::test]
    async fn live_engine_asset_refresh_when_requested() {
        if std::env::var("PRTS_LIVE_NETWORK").ok().as_deref() != Some("1") {
            return;
        }
        let result = refresh_engine_asset(
            "https://static.prts.wiki/assets/scenario/krliov.toolbox.js".to_string(),
            "krliov.toolbox.js".to_string(),
        )
        .await
        .unwrap();
        assert!(result.fresh);
        assert_eq!(result.sha256.len(), 64);
    }
}
