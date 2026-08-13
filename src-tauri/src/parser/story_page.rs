use scraper::{Html, Selector};

use crate::models::StoryPageData;

/// Prefer the simulator whose DOM owns the requested page's script. MediaWiki
/// can render examples/templates containing another #datas_txt before the real
/// one; blindly taking the first duplicate pairs the wrong script with the engine.
pub fn extract_story_script_for(html: &str, expected_title: Option<&str>) -> Option<StoryPageData> {
    let document = Html::parse_document(html);

    // Extract script from <pre id="datas_txt">
    let txt_sel = Selector::parse("#datas_txt").unwrap();
    let scripts: Vec<String> = document
        .select(&txt_sel)
        .map(|el| el.text().collect::<String>())
        .filter(|script| !script.trim().is_empty())
        .collect();
    let script = scripts.into_iter().max_by_key(|script| script.len())?;

    // Extract page title from <h1 id="firstHeading">
    let title_sel = Selector::parse("#firstHeading").unwrap();
    let title = document
        .select(&title_sel)
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .unwrap_or_default();

    let title = if title.is_empty() {
        expected_title.unwrap_or_default().to_string()
    } else {
        title
    };
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
    // Do not couple extraction to today's <pre> tag. The IDs are the engine's
    // actual contract; PRTS may move a table to another raw-text/container tag.
    let data_sel = Selector::parse("[id^=\"datas_\"]").unwrap();
    let mut data_blocks: Vec<(String, String)> = Vec::new();
    let mut background_entries = 0;
    let mut character_entries = 0;
    let mut audio_entries = 0;
    let mut link_groups = None;
    for el in document.select(&data_sel) {
        let Some(id) = el.value().id().map(str::to_string) else {
            continue;
        };
        let text = el.text().collect::<String>();
        match id.as_str() {
            "datas_back" => background_entries = nonempty_lines(&text),
            "datas_char" => character_entries = nonempty_lines(&text),
            "datas_audio" => {
                audio_entries = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|value| value.as_object().map(|object| object.len()))
                    .unwrap_or_default();
            }
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
    let engine_script_bytes = engine_scripts.iter().map(String::len).sum();
    let joined_engine = engine_scripts.join("\n");
    let engine_capabilities = [
        ("Timer", "function Timer"),
        ("system", "var system"),
        ("data.init", "data.init"),
        ("fun_sys_init", "fun_sys_init"),
        ("fun_sys_preload", "fun_sys_preload"),
        ("window.onload", "window.onload"),
    ]
    .into_iter()
    .filter(|(_, marker)| joined_engine.contains(marker))
    .map(|(name, _)| name.to_string())
    .collect();

    let dom_ids = [
        "sys_main",
        "sys_clicker",
        "dialog_output",
        "button_playback",
        "button_playback_all",
        "button_auto",
        "button_reset",
        "sys_audio",
    ];
    let dom_element_ids = dom_ids
        .into_iter()
        .filter(|id| {
            Selector::parse(&format!("#{id}"))
                .ok()
                .is_some_and(|selector| document.select(&selector).next().is_some())
        })
        .map(str::to_string)
        .collect();

    WidgetBundle {
        dom_html,
        data_blocks_html,
        engine_scripts,
        data_block_ids,
        background_entries,
        character_entries,
        audio_entries,
        link_groups,
        dom_element_ids,
        engine_script_bytes,
        engine_capabilities,
    }
}

/// Extract inline engine scripts structurally and semantically. The class name is
/// only a legacy hint: PRTS has changed surrounding MediaWiki markup before, so a
/// class rename must not make the player silently cache an empty engine.
fn extract_inline_scripts(html: &str) -> Vec<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("script:not([src])").unwrap();
    let scripts: Vec<(bool, String)> = document
        .select(&selector)
        // Script elements are parsed in HTML's raw-text state.  Serialising their
        // children with `inner_html()` escapes JavaScript operators (`&&` becomes
        // `&amp;&amp;`, `=>` becomes `=&gt;`), producing invalid source in the
        // WebView.  Read the text node itself so the engine code remains byte-for-
        // byte executable while retaining structural tag/class matching.
        .map(|el| {
            let legacy_class = el
                .value()
                .classes()
                .any(|class| class == "navigation-not-searchable");
            (
                legacy_class,
                el.text().collect::<String>().trim().to_string(),
            )
        })
        .filter(|(_, script)| !script.is_empty())
        .collect();
    let semantic: Vec<String> = scripts
        .iter()
        .filter(|(_, script)| is_engine_script(script))
        .map(|(_, script)| script.clone())
        .collect();
    let semantic_source = semantic.join("\n");
    if [
        "function Timer",
        "fun_sys_preload",
        "window.onload",
        "var system",
        "data.init",
    ]
    .iter()
    .all(|marker| semantic_source.contains(marker))
    {
        semantic
    } else {
        scripts
            .into_iter()
            .filter(|(legacy_class, _)| *legacy_class)
            .map(|(_, script)| script)
            .collect()
    }
}

fn is_engine_script(script: &str) -> bool {
    [
        "function Timer",
        "function txt_analyze",
        "function fun_sys_preload",
        "window.onload",
        "var system",
        "data.init",
    ]
    .iter()
    .any(|marker| script.contains(marker))
}

pub struct WidgetBundle {
    pub dom_html: String,
    pub data_blocks_html: String,
    pub engine_scripts: Vec<String>,
    pub data_block_ids: Vec<String>,
    pub background_entries: usize,
    pub character_entries: usize,
    pub audio_entries: usize,
    pub link_groups: Option<usize>,
    pub dom_element_ids: Vec<String>,
    pub engine_script_bytes: usize,
    pub engine_capabilities: Vec<String>,
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
          <script type="text/javascript" class="x navigation-not-searchable y">
            if (window.future && (() => 1 < 2)()) window.future = true;
          </script>
        "#;
        let bundle = extract_widget_html(html);
        assert!(bundle.data_block_ids.contains(&"datas_future".to_string()));
        assert!(bundle.data_blocks_html.contains("id=\"datas_future\""));
        assert_eq!(
            bundle.engine_scripts,
            vec!["if (window.future && (() => 1 < 2)()) window.future = true;"]
        );
        assert!(!bundle.engine_scripts[0].contains("&amp;"));
        assert!(!bundle.engine_scripts[0].contains("&gt;"));
    }

    #[test]
    fn survives_upstream_class_and_data_tag_changes() {
        let html = r#"
          <div id="sys_fullscreen"><div id="sys_main"></div></div><div id="sys_audio"></div>
          <template id="datas_future">future</template>
          <script class="renamed-widget-class">function Timer(){}</script>
          <script>function txt_analyze(){}</script>
          <script>window.onload=function(){}; function fun_sys_preload(){}</script>
          <script>var system={}; data.init();</script>
        "#;
        let bundle = extract_widget_html(html);
        assert!(bundle.data_block_ids.contains(&"datas_future".to_string()));
        assert_eq!(bundle.engine_scripts.len(), 4);
        assert!(bundle.engine_capabilities.contains(&"Timer".to_string()));
        assert!(bundle.engine_capabilities.contains(&"system".to_string()));
        assert!(bundle
            .engine_capabilities
            .contains(&"window.onload".to_string()));
    }

    #[test]
    fn story_extraction_ignores_short_duplicate_template_example() {
        let html = r#"
          <pre id="datas_txt">example</pre>
          <pre id="datas_txt">[Background(image="real")]\nThe actual longer story.</pre>
        "#;
        let story = extract_story_script_for(html, Some("CH/ST")).unwrap();
        assert!(story.script.contains("actual longer story"));
        assert_eq!(story.title, "CH/ST");
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
        assert!(
            bundle.engine_scripts.iter().all(|script| {
                !script.contains("&amp;&amp;")
                    && !script.contains("=&gt;")
                    && !script.contains("&lt;")
            }),
            "engine scripts contain HTML-escaped JavaScript operators"
        );
        assert!(bundle.background_entries > 100);
        assert!(bundle.character_entries > 100);
        assert!(bundle.link_groups.unwrap_or_default() > 50);
    }
}
