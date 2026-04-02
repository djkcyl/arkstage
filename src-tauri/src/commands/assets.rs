use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Get the assets directory path.
fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let assets_dir = dir.join("assets");
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
    app: AppHandle,
) -> Result<String, String> {
    let dir = assets_dir(&app)?;
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

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "PRTSReader/0.1")
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
    app: AppHandle,
) -> Result<Option<String>, String> {
    let dir = assets_dir(&app)?;
    let path = dir.join(&category).join(&filename);

    if path.exists() {
        Ok(path.to_str().map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

/// Batch download multiple assets. Returns the number of successfully downloaded assets.
#[tauri::command]
pub async fn batch_download_assets(
    assets: Vec<AssetDownloadRequest>,
    app: AppHandle,
) -> Result<BatchDownloadResult, String> {
    let dir = assets_dir(&app)?;
    let client = reqwest::Client::new();

    let mut success_count = 0u32;
    let mut fail_count = 0u32;
    let total = assets.len() as u32;

    for asset in assets {
        let category_dir = dir.join(&asset.category);
        std::fs::create_dir_all(&category_dir).ok();

        let path = category_dir.join(&asset.filename);
        if path.exists() {
            success_count += 1;
            continue;
        }

        match client
            .get(&asset.url)
            .header("User-Agent", "PRTSReader/0.1")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(bytes) = resp.bytes().await {
                    if std::fs::write(&path, &bytes).is_ok() {
                        success_count += 1;
                        continue;
                    }
                }
                fail_count += 1;
            }
            _ => {
                fail_count += 1;
            }
        }
    }

    Ok(BatchDownloadResult {
        total,
        success: success_count,
        failed: fail_count,
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct AssetDownloadRequest {
    pub url: String,
    pub category: String,
    pub filename: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchDownloadResult {
    pub total: u32,
    pub success: u32,
    pub failed: u32,
}
