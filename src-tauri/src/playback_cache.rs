//! IPC downloads have no Wry custom-protocol 10s response deadline. Prepare
//! missing bytes here, then WebView protocol requests only read local files.
use std::collections::HashMap;
use std::path::PathBuf;
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
    let root = crate::media::media_root(&crate::data_root::data_root());
    ensure_asset_at(url, refresh, root).await
}

async fn ensure_asset_at(url: String, refresh: bool, root: PathBuf) -> Result<(), String> {
    if !refresh || !crate::net::allow_online() {
        let read_root = root.clone();
        let read_url = url.clone();
        let valid = tokio::task::spawn_blocking(move || {
            // Writes use atomic replacement, so readers can use the old valid
            // bytes while a refresh holds the network lock. This peek never
            // deletes an invalid file or races with a replacement's cleanup.
            crate::media::store_path(&read_root, &read_url)
                .and_then(|path| std::fs::read(path).ok())
                .is_some_and(|bytes| crate::media::validate_asset_bytes(&read_url, &bytes).is_ok())
        })
        .await
        .map_err(|error| error.to_string())?;
        if valid {
            return Ok(());
        }
    }
    let lock = lock_for(&url);
    let _guard = lock.lock().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct CacheRoot(PathBuf);
    impl CacheRoot {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "arkstage-playback-cache-{name}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for CacheRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn valid_local_bytes_do_not_wait_for_the_network_refresh_lock() {
        let root = CacheRoot::new("valid");
        let url = "https://torappu.prts.wiki/assets/test-cache-valid.json";
        crate::media::write_local(&root.0, url, br#"{"ok":true}"#).unwrap();
        let lock = lock_for(url);
        let _refresh_in_progress = lock.lock().await;
        tokio::time::timeout(
            Duration::from_millis(500),
            ensure_asset_at(url.into(), false, root.0.clone()),
        )
        .await
        .expect("cache read waited behind an unrelated network request")
        .unwrap();
    }

    #[tokio::test]
    async fn missing_bytes_still_wait_for_the_single_download_owner() {
        let root = CacheRoot::new("missing");
        let url = "https://torappu.prts.wiki/assets/test-cache-missing.json";
        let lock = lock_for(url);
        let _download_in_progress = lock.lock().await;
        assert!(tokio::time::timeout(
            Duration::from_millis(50),
            ensure_asset_at(url.into(), false, root.0.clone())
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn invalid_local_bytes_do_not_bypass_the_download_lock_or_delete_a_replacement() {
        let root = CacheRoot::new("invalid");
        let url = "https://torappu.prts.wiki/assets/test-cache-invalid.json";
        crate::media::write_local(&root.0, url, b"<html>error</html>").unwrap();
        let lock = lock_for(url);
        let _download_in_progress = lock.lock().await;
        assert!(tokio::time::timeout(
            Duration::from_millis(50),
            ensure_asset_at(url.into(), false, root.0.clone())
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(crate::media::store_path(&root.0, url).unwrap()).unwrap(),
            b"<html>error</html>"
        );
    }
}
