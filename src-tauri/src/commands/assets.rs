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

    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write asset file: {}", e))?;

    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path".to_string())
}

/// Check if an asset is cached locally and return its path.
#[tauri::command]
pub async fn get_asset_path(
    category: String,
    filename: String,
) -> Result<Option<String>, String> {
    let dir = assets_dir()?;
    let path = dir.join(&category).join(&filename);

    if path.exists() {
        Ok(path.to_str().map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

/// Read a cached text asset and return its content as a string.
#[tauri::command]
pub async fn read_asset_text(
    category: String,
    filename: String,
) -> Result<Option<String>, String> {
    let dir = assets_dir()?;
    let path = dir.join(&category).join(&filename);

    if path.exists() {
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
