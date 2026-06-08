mod android_service;
mod commands;
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
            let content_type = guess_content_type(path);

            let media_root = media::media_root(&data_root::data_root());

            // 1) Serve from local content-addressed store if present (offline).
            if let Some(bytes) = media::read_local(&media_root, &target_url) {
                let r = tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", content_type)
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
            tauri::async_runtime::spawn(async move {
                let client = net::client();
                match client
                    .get(&target_url)
                    .header("Referer", "https://prts.wiki/")
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        let ct = resp
                            .headers()
                            .get("content-type")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or(content_type)
                            .to_string();

                        match resp.bytes().await {
                            Ok(bytes) => {
                                let _ = media::write_local(&media_root, &target_url, &bytes);
                                let r = tauri::http::Response::builder()
                                    .status(200)
                                    .header("Content-Type", ct)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(bytes.to_vec())
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
            // Asset management
            assets::download_asset,
            assets::get_asset_path,
            assets::read_asset_text,
            // Managed bulk downloads
            download::download_start,
            download::download_add,
            download::download_close,
            download::download_pause,
            download::download_resume,
            download::download_cancel,
            download::download_status,
            download::download_settings_get,
            download::download_settings_set,
            download::set_download_keepalive,
            // Network policy
            net::set_allow_online,
            net::get_allow_online,
            // Resource directory
            data_root::get_resource_dir,
            data_root::set_resource_dir,
            data_root::reset_resource_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
