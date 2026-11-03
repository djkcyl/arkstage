//! IPC downloads have no Wry custom-protocol 10s response deadline. Prepare
//! missing bytes here, then WebView protocol requests only read local files.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

fn lock_for(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if locks.len() > 256 {
        locks.retain(|_, lock| lock.strong_count() > 0);
    }
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key.into(), Arc::downgrade(&lock));
    lock
}

#[tauri::command]
pub async fn ensure_playback_asset(url: String, refresh: bool) -> Result<(), String> {
    // This command is only for engine assets; do not turn arbitrary URLs or
    // redirects into an authenticated/app-origin network proxy.
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some("static.prts.wiki" | "torappu.prts.wiki" | "media.prts.wiki")
        )
    {
        return Err("Invalid playback asset origin".into());
    }
    let lock = lock_for(&url);
    let _guard = lock.lock().await;
    let root = crate::media::media_root(&crate::data_root::data_root());
    let read_root = root.clone();
    let read_url = url.clone();
    let cached = tokio::task::spawn_blocking(move || {
        crate::media::read_local_validated(&read_root, &read_url)
    })
    .await
    .map_err(|e| e.to_string())?;
    if cached.is_some() && (!refresh || !crate::net::allow_online()) {
        return Ok(());
    }
    crate::net::ensure_online()?;
    static NETWORK: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let _permit = NETWORK
        .get_or_init(|| tokio::sync::Semaphore::new(4))
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    log::info!(
        "[playback-cache] {} {url}",
        if refresh { "revalidate" } else { "download" }
    );
    if refresh {
        match crate::http_cache::fetch(&url, cached.as_deref()).await {
            Ok(result) => {
                if let Err(error) = crate::media::validate_asset_bytes(&url, &result.bytes) {
                    if cached.is_some() {
                        log::warn!(
                            "[playback-cache] rejected invalid update; retained {url}: {error}"
                        );
                        return Ok(());
                    }
                    return Err(error);
                }
                if !result.not_modified {
                    crate::media::write_local(&root, &url, &result.bytes)?;
                }
                crate::http_cache::remember(&url, &result);
                return Ok(());
            }
            Err(error) if cached.is_some() => {
                log::warn!("[playback-cache] revalidation failed; retained {url}: {error}");
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }
    let response = crate::net::client()
        .get(&url)
        .header("Referer", "https://prts.wiki/")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    crate::media::validate_asset_bytes(&url, &bytes)?;
    tokio::task::spawn_blocking(move || {
        let stored = crate::compress::maybe_transcode_image(&url, bytes);
        crate::media::write_local(&root, &url, &stored)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(())
}
