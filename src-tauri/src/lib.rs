mod commands;
mod models;
mod parser;

use commands::{assets, cache, wiki};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
            wiki::fetch_asset_databases,
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
            assets::batch_download_assets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
