use crate::models::{Category, Chapter, StoryEntry, StoryIndex};
use scraper::{Html, Selector};

/// Parse the 剧情一览 page HTML into a structured StoryIndex.
/// The page contains wikitable tables with story links organized by category/chapter.
pub fn parse_story_index(html: &str) -> StoryIndex {
    let document = Html::parse_document(html);
    let table_sel = Selector::parse("table.wikitable").unwrap();
    let tr_sel = Selector::parse("tr").unwrap();
    let th_sel = Selector::parse("th").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let a_sel = Selector::parse("a[href]").unwrap();

    let mut categories: Vec<Category> = Vec::new();

    for table in document.select(&table_sel) {
        let rows: Vec<_> = table.select(&tr_sel).collect();
        if rows.is_empty() {
            continue;
        }

        // First row with colspan th is the category title
        let first_row = rows[0];
        let ths: Vec<_> = first_row.select(&th_sel).collect();
        let category_name = if !ths.is_empty() {
            ths[0].text().collect::<String>().trim().to_string()
        } else {
            continue;
        };

        // Skip nav-only tables without story content
        if category_name.is_empty() {
            continue;
        }

        let mut chapters: Vec<Chapter> = Vec::new();
        let mut current_group = String::new();

        for row in rows.iter().skip(1) {
            let ths: Vec<_> = row.select(&th_sel).collect();
            let tds: Vec<_> = row.select(&td_sel).collect();

            if tds.is_empty() {
                continue;
            }

            // Determine chapter name from th elements
            // Pattern: <th>group</th><th>chapter</th><td>links</td>
            // or: <th>chapter</th><td>links</td> (when group has rowspan)
            let chapter_name = match ths.len() {
                0 => "未分类".to_string(),
                1 => {
                    let text = ths[0].text().collect::<String>().trim().to_string();
                    if text.is_empty() {
                        current_group.clone()
                    } else {
                        // Could be either group or chapter depending on context
                        // If there's a rowspan, it's a group header
                        if ths[0].value().attr("rowspan").is_some() {
                            current_group = text.clone();
                            text
                        } else {
                            text
                        }
                    }
                }
                _ => {
                    // First th is group, subsequent are chapter
                    let group = ths[0].text().collect::<String>().trim().to_string();
                    if !group.is_empty() {
                        current_group = group;
                    }
                    let chapter = ths.last().unwrap().text().collect::<String>().trim().to_string();
                    if chapter.is_empty() {
                        current_group.clone()
                    } else {
                        chapter
                    }
                }
            };

            // Extract story links from td
            let td = tds.last().unwrap();
            let mut stories: Vec<StoryEntry> = Vec::new();

            for link in td.select(&a_sel) {
                let href = link.value().attr("href").unwrap_or("");
                let display_text = link.text().collect::<String>().trim().to_string();

                if display_text.is_empty() || !href.starts_with("/w/") {
                    continue;
                }

                // Extract page title from href: /w/URL_ENCODED_TITLE
                let page_title = href.trim_start_matches("/w/");
                let page_title = urlencoding::decode(page_title)
                    .unwrap_or_else(|_| page_title.into())
                    .into_owned();

                stories.push(StoryEntry {
                    title: display_text,
                    page_title,
                });
            }

            if !stories.is_empty() {
                chapters.push(Chapter {
                    name: chapter_name,
                    stories,
                });
            }
        }

        if !chapters.is_empty() {
            categories.push(Category {
                name: category_name,
                chapters,
            });
        }
    }

    StoryIndex { categories }
}
