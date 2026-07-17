use crate::models::{
    StoryIndex, StoryPageData, StoryRuntimeData, WidgetBundleData, WidgetDiagnostics,
};
use crate::parser::{story_index, story_page};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const _WIKI_API: &str = "https://prts.wiki/api.php";

/// Build a wiki API URL to fetch parsed page HTML.
/// Reserved for future use with MediaWiki parse API.
#[allow(dead_code)]
fn api_url(page: &str) -> String {
    let encoded = urlencoding::encode(page);
    format!(
        "{}?action=parse&page={}&format=json&prop=text&utf8=1",
        _WIKI_API, encoded
    )
}

/// Fetch raw HTML content of a wiki page via MediaWiki API.
/// Reserved for future use when API returns data blocks correctly.
#[allow(dead_code)]
async fn fetch_page_html(page: &str) -> Result<String, String> {
    let url = api_url(page);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "PRTSReader/0.1")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), url));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse API JSON: {}", e))?;

    // MediaWiki API returns { parse: { text: { "*": "HTML_CONTENT" } } }
    json.get("parse")
        .and_then(|p| p.get("text"))
        .and_then(|t| t.get("*"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Unexpected API response structure".to_string())
}

/// Fetch the full raw HTML of a wiki page (not via API, direct page fetch).
/// This is needed for story pages that embed <pre> data blocks,
/// since the API may not return those correctly.
async fn fetch_page_raw(page: &str) -> Result<String, String> {
    // Offline gate: when networking is off, refuse instead of silently fetching.
    crate::net::ensure_online()?;
    let encoded = urlencoding::encode(page);
    let url = format!("https://prts.wiki/w/{}", encoded);
    let resp = crate::net::client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), url));
    }

    resp.text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Fetch the story index by parsing prts.wiki's 剧情一览 HTML. The app ships a
/// bundled `index.json` as the offline baseline; this command refreshes it.
#[tauri::command]
pub async fn fetch_story_index() -> Result<StoryIndex, String> {
    let html = fetch_page_raw("剧情一览").await?;
    Ok(story_index::parse_story_index(&html))
}

/// Cheap MediaWiki oldid lookup used to decide whether a cached story script and
/// manifest are still current. Requests are batched to avoid re-downloading the
/// multi-megabyte rendered ScenarioSimulator tables for every unchanged story.
#[tauri::command]
pub async fn fetch_page_revisions(titles: Vec<String>) -> Result<HashMap<String, String>, String> {
    crate::net::ensure_online()?;
    let mut result = HashMap::new();
    for chunk in titles.chunks(50) {
        let joined = chunk.join("|");
        let json: serde_json::Value = crate::net::client()
            .get(_WIKI_API)
            .query(&[
                ("action", "query"),
                ("prop", "revisions"),
                ("rvprop", "ids|timestamp"),
                ("redirects", "1"),
                ("format", "json"),
                ("formatversion", "2"),
                ("titles", joined.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Revision query failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Revision query HTTP error: {e}"))?
            .json()
            .await
            .map_err(|e| format!("Invalid revision response: {e}"))?;
        if let Some(pages) = json.pointer("/query/pages").and_then(|v| v.as_array()) {
            for page in pages {
                let Some(title) = page.get("title").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(revision) = page.pointer("/revisions/0/revid").and_then(|v| v.as_u64())
                else {
                    continue;
                };
                result.insert(title.to_string(), revision.to_string());
            }
        }
    }
    Ok(result)
}

/// Fetch a single story page and extract its script.
#[tauri::command]
pub async fn fetch_story_page(page_title: String) -> Result<StoryPageData, String> {
    let html = fetch_page_raw(&page_title).await?;
    story_page::extract_story_script(&html)
        .ok_or_else(|| format!("No story script found on page: {}", page_title))
}

/// Fetch the original ScenarioSimulator widget bundle from any story page.
/// Extracts: DOM structure, shared data blocks (as raw HTML), and inline engine scripts.
/// This is used to run the original engine code as-is.
#[tauri::command]
pub async fn fetch_widget_bundle(page_title: String) -> Result<WidgetBundleData, String> {
    let html = fetch_page_raw(&page_title).await?;
    widget_from_html(&html)
}

/// Fetch the script and engine/data snapshot from one rendered page response.
/// This is the strongest synchronization path used by interactive playback.
#[tauri::command]
pub async fn fetch_story_runtime(page_title: String) -> Result<StoryRuntimeData, String> {
    let html = fetch_page_raw(&page_title).await?;
    let story = story_page::extract_story_script(&html)
        .ok_or_else(|| format!("No story script found on page: {}", page_title))?;
    let bundle = widget_from_html(&html)?;
    let revision = sha256_parts(&[story.script.as_bytes(), bundle.revision.as_bytes()]);
    Ok(StoryRuntimeData {
        story,
        bundle,
        revision,
    })
}

fn widget_from_html(html: &str) -> Result<WidgetBundleData, String> {
    let bundle = story_page::extract_widget_html(html);

    if bundle.engine_scripts.is_empty() {
        return Err("No engine scripts found on page".to_string());
    }

    let required = [
        "datas_txt",
        "datas_back",
        "datas_char",
        "datas_audio",
        "datas_link",
    ];
    let missing: Vec<&str> = required
        .into_iter()
        .filter(|id| !bundle.data_block_ids.iter().any(|got| got == id))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Incomplete ScenarioSimulator data: missing {}",
            missing.join(", ")
        ));
    }
    if !bundle.dom_html.contains("sys_main") {
        return Err("Incomplete ScenarioSimulator DOM: #sys_main missing".to_string());
    }

    let background_entries = bundle.background_entries;
    let character_entries = bundle.character_entries;
    let link_groups = bundle
        .link_groups
        .ok_or_else(|| "Invalid datas_link JSON".to_string())?;

    // A partially cached/truncated PRTS response can still contain all element
    // IDs. Reject obviously incomplete snapshots before they replace last-known-good.
    if background_entries < 100 || character_entries < 100 || link_groups < 50 {
        return Err(format!(
            "Suspiciously small ScenarioSimulator tables (backgrounds={background_entries}, characters={character_entries}, links={link_groups})"
        ));
    }

    let revision = sha256_parts(&[
        bundle.dom_html.as_bytes(),
        bundle.data_blocks_html.as_bytes(),
        bundle.engine_scripts.join("\n").as_bytes(),
    ]);

    let engine_script_count = bundle.engine_scripts.len();
    Ok(WidgetBundleData {
        dom_html: bundle.dom_html,
        data_blocks_html: bundle.data_blocks_html,
        engine_scripts: bundle.engine_scripts,
        revision,
        diagnostics: WidgetDiagnostics {
            data_block_ids: bundle.data_block_ids,
            background_entries,
            character_entries,
            link_groups,
            engine_script_count,
        },
    })
}

fn sha256_parts(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part);
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in real network smoke test:
    /// `PRTS_LIVE_NETWORK=1 cargo test live_story_runtime`.
    #[tokio::test]
    async fn live_story_runtime_when_requested() {
        if std::env::var("PRTS_LIVE_NETWORK").ok().as_deref() != Some("1") {
            return;
        }
        let runtime = fetch_story_runtime("BD-ST1 土壤病/NBT".to_string())
            .await
            .unwrap();
        assert_eq!(runtime.revision.len(), 64);
        assert!(runtime.bundle.diagnostics.character_entries > 100);
        assert!(runtime
            .bundle
            .data_blocks_html
            .contains("avg_4229_aphris_1-1$2"));
        assert!(runtime
            .bundle
            .data_blocks_html
            .contains("bg_75_mini01_plantation"));
    }
}
