use crate::models::{
    StoryIndex, StoryPageData, StoryRuntimeData, WidgetBundleData, WidgetDiagnostics,
};
use crate::parser::{story_index, story_page};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;

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
    crate::net::ensure_online()?;
    let resp = crate::net::client()
        .get(&url)
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
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let response = crate::net::client()
            .get(&url)
            .header("Referer", "https://prts.wiki/")
            .send()
            .await;
        match response {
            Ok(resp) if resp.status().is_success() => {
                if resp
                    .content_length()
                    .is_some_and(|len| len > 20 * 1024 * 1024)
                {
                    return Err(format!("PRTS response is unexpectedly large: {url}"));
                }
                let content_type = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !content_type.is_empty()
                    && !content_type.contains("text/html")
                    && !content_type.contains("application/xhtml")
                {
                    return Err(format!(
                        "Unexpected PRTS content type {content_type}: {url}"
                    ));
                }
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Failed to read response: {e}"))?;
                if bytes.len() > 20 * 1024 * 1024 {
                    return Err(format!("PRTS response is unexpectedly large: {url}"));
                }
                let html = String::from_utf8(bytes.to_vec())
                    .map_err(|_| format!("PRTS response is not UTF-8 HTML: {url}"))?;
                if !html.to_ascii_lowercase().contains("<html") {
                    return Err(format!(
                        "PRTS response does not contain an HTML document: {url}"
                    ));
                }
                return Ok(html);
            }
            Ok(resp) => {
                let status = resp.status();
                last_error = format!("HTTP {status}: {url}");
                if status.is_client_error() && status.as_u16() != 429 {
                    break;
                }
            }
            Err(error) => last_error = format!("HTTP request failed: {error}"),
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_millis(attempt * 350)).await;
        }
    }
    Err(last_error)
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
    story_page::extract_story_script_for(&html, Some(&page_title))
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
    let story = story_page::extract_story_script_for(&html, Some(&page_title))
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
    let required_dom = [
        "sys_main",
        "sys_clicker",
        "dialog_output",
        "button_playback",
        "button_playback_all",
        "button_auto",
        "button_reset",
        "sys_audio",
    ];
    let missing_dom: Vec<&str> = required_dom
        .into_iter()
        .filter(|id| !bundle.dom_element_ids.iter().any(|got| got == id))
        .collect();
    if !missing_dom.is_empty() {
        return Err(format!(
            "Incomplete ScenarioSimulator DOM: missing {}",
            missing_dom.join(", ")
        ));
    }

    let background_entries = bundle.background_entries;
    let character_entries = bundle.character_entries;
    let audio_entries = bundle.audio_entries;
    let link_groups = bundle
        .link_groups
        .ok_or_else(|| "Invalid datas_link JSON".to_string())?;

    // A partially cached/truncated PRTS response can still contain all element
    // IDs. Reject obviously incomplete snapshots before they replace last-known-good.
    if background_entries < 100 || character_entries < 100 || audio_entries < 10 || link_groups < 50
    {
        return Err(format!(
            "Suspiciously small ScenarioSimulator tables (backgrounds={background_entries}, characters={character_entries}, audio={audio_entries}, links={link_groups})"
        ));
    }

    let required_capabilities = [
        "Timer",
        "system",
        "data.init",
        "fun_sys_init",
        "fun_sys_preload",
        "window.onload",
    ];
    let missing_capabilities: Vec<&str> = required_capabilities
        .into_iter()
        .filter(|name| !bundle.engine_capabilities.iter().any(|got| got == name))
        .collect();
    if !missing_capabilities.is_empty() || bundle.engine_script_bytes < 10_000 {
        return Err(format!(
            "Incomplete ScenarioSimulator engine (bytes={}, missing={})",
            bundle.engine_script_bytes,
            missing_capabilities.join(", ")
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
            dom_element_ids: bundle.dom_element_ids,
            background_entries,
            character_entries,
            audio_entries,
            link_groups,
            engine_script_count,
            engine_script_bytes: bundle.engine_script_bytes,
            engine_capabilities: bundle.engine_capabilities,
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

    #[test]
    fn rejects_markerless_or_tiny_engine_before_cache_promotion() {
        let backgrounds = (0..101)
            .map(|i| format!("bg_{i},u"))
            .collect::<Vec<_>>()
            .join("\n");
        let characters = (0..101)
            .map(|i| format!("char_{i},u"))
            .collect::<Vec<_>>()
            .join("\n");
        let audio = serde_json::to_string(
            &(0..11)
                .map(|i| (format!("a{i}"), "u"))
                .collect::<HashMap<_, _>>(),
        )
        .unwrap();
        let links = serde_json::to_string(
            &(0..51)
                .map(|i| (format!("c{i}"), serde_json::json!({})))
                .collect::<HashMap<_, _>>(),
        )
        .unwrap();
        let html = format!(
            r#"
          <h1 id="firstHeading">Broken</h1>
          <div id="sys_fullscreen">
            <div id="sys_main"></div><div id="sys_clicker"></div>
            <div id="dialog_output"></div><button id="button_playback"></button>
            <button id="button_playback_all"></button><button id="button_auto"></button>
            <button id="button_reset"></button>
          </div><div id="sys_audio"></div>
          <pre id="datas_txt">story</pre>
          <pre id="datas_back">{backgrounds}</pre><pre id="datas_char">{characters}</pre>
          <pre id="datas_audio">{audio}</pre><pre id="datas_link">{links}</pre>
          <script class="navigation-not-searchable">console.log('not the engine')</script>
        "#
        );
        let error = widget_from_html(&html).unwrap_err();
        assert!(error.contains("Incomplete ScenarioSimulator engine"));
    }
}
