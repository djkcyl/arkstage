use scraper::{Html, Selector};

use crate::models::StoryPageData;

/// Extract the story script (#datas_txt) from a story page HTML.
pub fn extract_story_script(html: &str) -> Option<StoryPageData> {
    let document = Html::parse_document(html);

    // Extract script from <pre id="datas_txt">
    let txt_sel = Selector::parse("#datas_txt").unwrap();
    let script = document.select(&txt_sel).next().map(|el| {
        // The content uses HTML entities, decode them
        let raw = el.text().collect::<String>();
        raw
    })?;

    // Extract page title from <h1 id="firstHeading">
    let title_sel = Selector::parse("#firstHeading").unwrap();
    let title = document
        .select(&title_sel)
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .unwrap_or_default();

    Some(StoryPageData { script, title })
}

/// Extract the complete widget HTML needed to run the original ScenarioSimulator.
/// Returns: DOM structure, data block elements, and inline script blocks.
pub fn extract_widget_html(html: &str) -> WidgetBundle {
    let document = Html::parse_document(html);

    // 1) Extract the main widget DOM: #sys_fullscreen container + #sys_audio
    //    Use .inner_html() to get the children only, then re-wrap with correct outer tag.
    //    Using .html() would include the outer tag itself, causing double-wrapping.
    let dom_html = {
        let fullscreen_sel = Selector::parse("#sys_fullscreen").unwrap();
        let audio_sel = Selector::parse("#sys_audio").unwrap();

        let fullscreen = document
            .select(&fullscreen_sel)
            .next()
            .map(|el| el.inner_html())
            .unwrap_or_default();

        let audio = document
            .select(&audio_sel)
            .next()
            .map(|el| el.inner_html())
            .unwrap_or_default();

        format!(
            "<div class=\"common_style\" id=\"sys_fullscreen\">{}</div>\n<div id=\"sys_audio\" style=\"display:none;\">{}</div>",
            fullscreen, audio
        )
    };

    // 2) Extract EVERY ScenarioSimulator data block in document order. PRTS has
    // historically added new `datas_*` tables; a fixed allow-list silently drops
    // those tables and later manifests/CG commands then fail without a parse error.
    let data_sel = Selector::parse("pre[id^=\"datas_\"]").unwrap();
    let mut data_blocks: Vec<(String, String)> = Vec::new();
    let mut background_entries = 0;
    let mut character_entries = 0;
    let mut link_groups = None;
    for el in document.select(&data_sel) {
        let Some(id) = el.value().id().map(str::to_string) else {
            continue;
        };
        let text = el.text().collect::<String>();
        match id.as_str() {
            "datas_back" => background_entries = nonempty_lines(&text),
            "datas_char" => character_entries = nonempty_lines(&text),
            "datas_link" => {
                link_groups = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|value| value.as_object().map(|object| object.len()));
            }
            _ => {}
        }
        data_blocks.push((
            id.clone(),
            format!(
                "<pre class=\"hidden\" id=\"{}\">{}</pre>",
                id,
                el.inner_html()
            ),
        ));
    }
    let data_block_ids = data_blocks.iter().map(|(id, _)| id.clone()).collect();
    let data_blocks_html = data_blocks
        .iter()
        .map(|(_, html)| html.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    // 3) Extract inline script blocks (class="navigation-not-searchable")
    //    scraper may not parse <script> content well, so use string-based extraction
    let engine_scripts = extract_inline_scripts(html);

    WidgetBundle {
        dom_html,
        data_blocks_html,
        engine_scripts,
        data_block_ids,
        background_entries,
        character_entries,
        link_groups,
    }
}

/// Extract inline engine scripts structurally. This accepts additional classes,
/// attributes and arbitrary attribute ordering instead of depending on one exact
/// opening-tag byte string.
fn extract_inline_scripts(html: &str) -> Vec<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("script.navigation-not-searchable").unwrap();
    document
        .select(&selector)
        .map(|el| el.inner_html().trim().to_string())
        .filter(|script| !script.is_empty())
        .collect()
}

pub struct WidgetBundle {
    pub dom_html: String,
    pub data_blocks_html: String,
    pub engine_scripts: Vec<String>,
    pub data_block_ids: Vec<String>,
    pub background_entries: usize,
    pub character_entries: usize,
    pub link_groups: Option<usize>,
}

fn nonempty_lines(text: &str) -> usize {
    text.lines().filter(|line| !line.trim().is_empty()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_future_data_blocks_and_flexible_script_tags() {
        let html = r#"
          <div id="sys_fullscreen"><div id="sys_main"></div></div><div id="sys_audio"></div>
          <pre id="datas_txt">hello</pre><pre id="datas_char">c,u</pre>
          <pre id="datas_future">future</pre>
          <script type="text/javascript" class="x navigation-not-searchable y">window.future = true;</script>
        "#;
        let bundle = extract_widget_html(html);
        assert!(bundle.data_block_ids.contains(&"datas_future".to_string()));
        assert!(bundle.data_blocks_html.contains("id=\"datas_future\""));
        assert_eq!(bundle.engine_scripts, vec!["window.future = true;"]);
    }

    /// Optional maintainer/CI hook for a freshly downloaded rendered PRTS page:
    /// `PRTS_LIVE_FIXTURE=/tmp/page.html cargo test live_prts_fixture`.
    #[test]
    fn live_prts_fixture_is_complete_when_provided() {
        let Ok(path) = std::env::var("PRTS_LIVE_FIXTURE") else {
            return;
        };
        let html = std::fs::read_to_string(path).unwrap();
        let bundle = extract_widget_html(&html);
        for id in [
            "datas_txt",
            "datas_back",
            "datas_char",
            "datas_audio",
            "datas_link",
        ] {
            assert!(
                bundle.data_block_ids.iter().any(|got| got == id),
                "missing {id}"
            );
        }
        assert!(bundle.dom_html.contains("sys_main"));
        assert!(bundle.engine_scripts.len() >= 3);
        assert!(bundle.background_entries > 100);
        assert!(bundle.character_entries > 100);
        assert!(bundle.link_groups.unwrap_or_default() > 50);
    }
}
