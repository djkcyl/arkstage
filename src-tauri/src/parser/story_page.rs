use scraper::{Html, Selector};

use crate::models::StoryPageData;

/// Extract the story script (#datas_txt) from a story page HTML.
pub fn extract_story_script(html: &str) -> Option<StoryPageData> {
    let document = Html::parse_document(html);

    // Extract script from <pre id="datas_txt">
    let txt_sel = Selector::parse("#datas_txt").unwrap();
    let script = document
        .select(&txt_sel)
        .next()
        .map(|el| {
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

    // 2) Extract data blocks as raw HTML <pre> elements
    let get_pre = |id: &str| -> String {
        let sel = Selector::parse(&format!("#{}", id)).unwrap();
        document
            .select(&sel)
            .next()
            .map(|el| format!("<pre class=\"hidden\" id=\"{}\">{}</pre>", id, el.inner_html()))
            .unwrap_or_default()
    };

    let data_blocks_html = [
        get_pre("datas_txt"),
        get_pre("datas_back"),
        get_pre("datas_char"),
        get_pre("datas_audio"),
        get_pre("datas_link"),
        get_pre("datas_override"),
    ]
    .join("\n");

    // 3) Extract inline script blocks (class="navigation-not-searchable")
    //    scraper may not parse <script> content well, so use string-based extraction
    let engine_scripts = extract_inline_scripts(html);

    WidgetBundle {
        dom_html,
        data_blocks_html,
        engine_scripts,
    }
}

/// Extract inline <script class="navigation-not-searchable"> blocks using string search.
/// The HTML parser may strip script content, so we do raw string matching.
fn extract_inline_scripts(html: &str) -> Vec<String> {
    let open_tag = "<script class=\"navigation-not-searchable\">";
    let close_tag = "</script>";
    let mut scripts = Vec::new();
    let mut search_from = 0;

    while let Some(start) = html[search_from..].find(open_tag) {
        let abs_start = search_from + start + open_tag.len();
        if let Some(end) = html[abs_start..].find(close_tag) {
            let content = &html[abs_start..abs_start + end];
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                scripts.push(trimmed.to_string());
            }
            search_from = abs_start + end + close_tag.len();
        } else {
            break;
        }
    }

    scripts
}

pub struct WidgetBundle {
    pub dom_html: String,
    pub data_blocks_html: String,
    pub engine_scripts: Vec<String>,
}
