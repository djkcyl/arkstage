mod commands;
mod media;
mod models;
mod net_state;
mod parser;

use commands::{assets, cache, wiki};
use std::sync::OnceLock;
use tauri::Manager;

/// App data dir captured at setup(), read by the prts-cdn:// handler (which has no AppHandle).
static APP_DATA_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

/// Build a small error response with permissive CORS.
fn respond_err(responder: tauri::UriSchemeResponder, status: u16, msg: String) {
    let r = tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.into_bytes())
        .unwrap();
    responder.respond(r);
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .build()
            .unwrap()
    })
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

            let media_root = APP_DATA_DIR.get().map(|d| media::media_root(d));

            // 1) Serve from local content-addressed store if present (offline).
            if let Some(root) = &media_root {
                if let Some(bytes) = media::read_local(root, &target_url) {
                    let r = tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", content_type)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes)
                        .unwrap();
                    responder.respond(r);
                    return;
                }
            }

            // 2) Not cached and offline mode: refuse with a marker the frontend detects.
            if !net_state::allow_online() {
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
            let media_root = media_root.clone();
            tauri::async_runtime::spawn(async move {
                let client = http_client();
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
                                if let Some(root) = &media_root {
                                    let _ = media::write_local(root, &target_url, &bytes);
                                }
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
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = APP_DATA_DIR.set(dir);
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
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
            assets::batch_download_assets,
            // Network policy
            net_state::set_allow_online,
            net_state::get_allow_online,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
