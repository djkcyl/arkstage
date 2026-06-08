use crate::models::{StoryIndex, StoryPageData, WidgetBundleData};
use crate::parser::{story_index, story_page};

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

/// Fetch and parse the story index from the 剧情一览 page.
#[tauri::command]
pub async fn fetch_story_index() -> Result<StoryIndex, String> {
    let html = fetch_page_raw("剧情一览").await?;
    Ok(story_index::parse_story_index(&html))
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
    let bundle = story_page::extract_widget_html(&html);

    if bundle.engine_scripts.is_empty() {
        return Err("No engine scripts found on page".to_string());
    }

    Ok(WidgetBundleData {
        dom_html: bundle.dom_html,
        data_blocks_html: bundle.data_blocks_html,
        engine_scripts: bundle.engine_scripts,
    })
}
