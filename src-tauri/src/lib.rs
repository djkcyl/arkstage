mod android_service;
mod commands;
mod compress;
mod data_root;
mod download;
mod media;
mod models;
mod net;
mod parser;

use commands::{assets, cache, wiki};
use tauri::Manager;

/// Build a small error response with permissive CORS.
fn respond_err(responder: tauri::UriSchemeResponder, status: u16, msg: String) {
    let r = tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.into_bytes())
        .unwrap();
    responder.respond(r);
}

/// Content-type from the file's magic bytes, falling back to the extension. Needed
/// because the compression feature stores WebP bytes under the original `.png`
/// key, so the extension can lie. `<img>` sniffs anyway, but a correct header is
/// the robust choice (and matters for any non-`<img>` consumer).
fn sniff_content_type(bytes: &[u8], path: &str) -> &'static str {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        guess_content_type(path)
    }
}

/// Guess content-type from file extension.
fn guess_content_type(path: &str) -> &'static str {
    if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".mp3") {
        "audio/mpeg"
    } else if path.ends_with(".ogg") {
        "audio/ogg"
    } else if path.ends_with(".wav") {
        "audio/wav"
    } else if path.ends_with(".mp4") {
        "video/mp4"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".js") {
        "application/javascript"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".ttf") {
        "font/ttf"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}

/// Open a URL in the system browser (Android intent / desktop default browser).
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("prts-cdn", |_app, request, responder| {
            // URL format:
            //   macOS/Linux: prts-cdn://localhost/{host}/{path}
            //   Windows:     http://prts-cdn.localhost/{host}/{path}
            // Extract path after host to build target URL.
            let uri = request.uri().clone();
            let path = uri.path().trim_start_matches('/');

            if path.is_empty() {
                let r = tauri::http::Response::builder()
                    .status(400)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(b"Empty path".to_vec())
                    .unwrap();
                responder.respond(r);
                return;
            }

            let query = uri.query().map(|q| format!("?{}", q)).unwrap_or_default();
            let target_url = format!("https://{}{}", path, query);

            let media_root = media::media_root(&data_root::data_root());

            // 1) Serve from local content-addressed store if present (offline).
            if let Some(bytes) = media::read_local(&media_root, &target_url) {
                // Sniff: a `.png` key may hold WebP bytes after compression.
                let ct = sniff_content_type(&bytes, path);
                let r = tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", ct)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap();
                responder.respond(r);
                return;
            }

            // 2) Not cached and offline mode: refuse with a marker the frontend detects.
            if !net::allow_online() {
                let r = tauri::http::Response::builder()
                    .status(503)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("X-PRTS-Offline", "1")
                    .body(b"offline: asset not cached".to_vec())
                    .unwrap();
                responder.respond(r);
                return;
            }

            // 3) Online: fetch, persist to store (cache-through), serve.
            // Own the path for the async block (the borrowed `uri` doesn't live to 'static).
            let path = path.to_string();
            tauri::async_runtime::spawn(async move {
                let path = path.as_str();
                let client = net::client();
                match client
                    .get(&target_url)
                    .header("Referer", "https://prts.wiki/")
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.bytes().await {
                            Ok(bytes) => {
                                // Real-time compression: when a tier is enabled and
                                // this is an image, store + serve the WebP bytes.
                                let stored = compress::maybe_transcode_image(
                                    &target_url,
                                    bytes.to_vec(),
                                );
                                let _ = media::write_local(&media_root, &target_url, &stored);
                                let ct = sniff_content_type(&stored, path);
                                let r = tauri::http::Response::builder()
                                    .status(200)
                                    .header("Content-Type", ct)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(stored)
                                    .unwrap();
                                responder.respond(r);
                            }
                            Err(e) => respond_err(responder, 502, format!("Read error: {}", e)),
                        }
                    }
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        respond_err(responder, status, format!("Upstream returned {}", status));
                    }
                    Err(e) => respond_err(responder, 502, format!("Fetch error: {}", e)),
                }
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                // App-private external storage (spec §2). Fall back to internal
                // app-data if external is somehow unavailable so the app still runs.
                match data_root::android_external_files_dir() {
                    Ok(dir) => {
                        log::info!("[data_root] android external files dir: {}", dir.display());
                        data_root::init_fixed(dir);
                    }
                    Err(e) => {
                        log::warn!("[data_root] external dir unavailable ({e}); using internal app_data");
                        if let Ok(dir) = app.path().app_data_dir() {
                            data_root::init_fixed(dir);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "android"))]
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    data_root::init(dir);
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Register the managed download engine (bulk predownload jobs).
            download::init(app.handle());
            // Restore compression mode + resume an interrupted batch if any.
            compress::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Wiki fetching
            wiki::fetch_story_index,
            wiki::fetch_story_page,
            wiki::fetch_widget_bundle,
            // Cache management
            cache::save_to_cache,
            cache::load_from_cache,
            cache::delete_from_cache,
            cache::list_cached_stories,
            cache::get_cache_status,
            cache::clear_cache,
            cache::delete_chapter_cache,
            // Asset management
            assets::download_asset,
            assets::get_asset_path,
            assets::read_asset_text,
            // Managed bulk downloads
            download::download_start,
            download::download_add,
            download::download_feed_cached,
            download::download_close,
            download::download_pause,
            download::download_resume,
            download::download_cancel,
            download::download_status,
            download::download_settings_get,
            download::download_settings_set,
            download::keepalive_set_reading,
            download::keepalive_set_manifest,
            // Network policy
            net::set_allow_online,
            net::get_allow_online,
            // Client-side image compression (资源压缩)
            compress::compress_estimate,
            compress::compress_get_config,
            compress::compress_start,
            compress::compress_pause,
            compress::compress_resume,
            compress::compress_cancel,
            compress::compress_status,
            compress::compress_disable_realtime,
            // Screen orientation (player forces landscape; elsewhere free) +
            // immersive system-bar hiding (player only)
            android_service::set_orientation,
            android_service::set_immersive,
            // Resource directory
            data_root::get_resource_dir,
            data_root::set_resource_dir,
            data_root::reset_resource_dir,
            // External links (About page)
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
