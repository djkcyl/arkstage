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

/// Read a cached text asset and return its content as a string.
#[tauri::command]
pub async fn read_asset_text(
    category: String,
    filename: String,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let dir = assets_dir(&app)?;
    let path = dir.join(&category).join(&filename);

    if path.exists() {
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed to read asset: {}", e))
    } else {
        Ok(None)
    }
}

/// Download a list of absolute CDN URLs into the content-addressed media store
/// (`$APPDATA/media/{host}/{path}`). Already-present files are skipped (cross-story
/// dedup). Sends a Referer header to avoid CDN 403s.
#[tauri::command]
pub async fn batch_download_assets(
    urls: Vec<String>,
    app: AppHandle,
) -> Result<BatchDownloadResult, String> {
    let root = crate::media::media_root(
        &app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?,
    );
    let client = reqwest::Client::new();

    let (mut success, mut failed, mut skipped) = (0u32, 0u32, 0u32);
    let total = urls.len() as u32;

    for url in urls {
        match crate::media::store_path(&root, &url) {
            Some(p) if p.exists() => {
                skipped += 1;
                continue;
            }
            None => {
                failed += 1;
                continue;
            }
            _ => {}
        }

        match client
            .get(&url)
            .header("Referer", "https://prts.wiki/")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(bytes) => match crate::media::write_local(&root, &url, &bytes) {
                    Ok(()) => success += 1,
                    Err(_) => failed += 1,
                },
                Err(_) => failed += 1,
            },
            _ => failed += 1,
        }
    }

    Ok(BatchDownloadResult {
        total,
        success,
        failed,
        skipped,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BatchDownloadResult {
    pub total: u32,
    pub success: u32,
    pub failed: u32,
    pub skipped: u32,
}
