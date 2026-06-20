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

            // Resolve the activity/zone label and the chapter's own (leaf) name.
            // Row layouts seen in the 剧情一览 tables:
            //   <th rowspan=N>group</th><th>event</th><td>…</td>  ← first row of a rowspan group
            //   <th>event</th><td>…</td>                          ← later rows of that group
            //   <th width=120>activity</th><th width=40>主线</th><td>…</td>  ← standalone activity row
            // We surface the broader label (the group, or the standalone activity)
            // as `activity_name`, and the specific leaf (event / 主线 / 支线) as `name`.
            let (activity_name, chapter_name) = match ths.len() {
                0 => (None, "未分类".to_string()),
                1 => {
                    // Continuation row inside a rowspan group: the lone th is the
                    // event/leaf, and the remembered group is its activity context.
                    let text = ths[0].text().collect::<String>().trim().to_string();
                    let act = (!current_group.is_empty()).then(|| current_group.clone());
                    if text.is_empty() {
                        (None, current_group.clone())
                    } else {
                        (act, text)
                    }
                }
                _ => {
                    let first = ths[0].text().collect::<String>().trim().to_string();
                    let last = ths.last().unwrap().text().collect::<String>().trim().to_string();
                    if ths[0].value().attr("rowspan").is_some() {
                        // Group header — remember it for the rows it spans.
                        current_group = first.clone();
                    } else {
                        // Standalone activity row: its own first th is the activity,
                        // so later single-th rows must not inherit a stale group.
                        current_group.clear();
                    }
                    let act = (!first.is_empty()).then_some(first);
                    let name = if last.is_empty() {
                        current_group.clone()
                    } else {
                        last
                    };
                    (act, name)
                }
            };
            // Don't repeat the activity label when it equals the leaf name.
            let activity_name = activity_name.filter(|a| *a != chapter_name);

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
                    activity_name,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Covers the three row layouts in the 剧情一览 tables: a rowspan group header
    // with its first event, a continuation row inside that group, and a standalone
    // activity row (width-sized th pair) whose leaf is just 主线/支线.
    const SAMPLE: &str = r#"
      <table class="wikitable">
        <tr><th colspan="3">主线剧情一览</th></tr>
        <tr>
          <th width="120px">黑暗时代·上</th>
          <th width="40px">主线</th>
          <td><a href="/w/W2G/BEG">序章·上</a></td>
        </tr>
      </table>
      <table class="wikitable">
        <tr><th colspan="3">活动剧情一览</th></tr>
        <tr>
          <th rowspan="2">集成战略</th>
          <th>刻俄柏的灰蕈迷境</th>
          <td><a href="/w/Phantom/1">傀影 1</a></td>
        </tr>
        <tr>
          <th>傀影与猩红孤钻</th>
          <td><a href="/w/Phantom/2">傀影 2</a></td>
        </tr>
        <tr>
          <th width="120px">骑兵与猎人</th>
          <th width="40px">支线</th>
          <td><a href="/w/GT/1">骑兵 1</a></td>
        </tr>
      </table>
    "#;

    #[test]
    fn extracts_activity_names_for_each_layout() {
        let idx = parse_story_index(SAMPLE);
        assert_eq!(idx.categories.len(), 2);

        // Standalone activity row: activity = zone, name = 主线/支线.
        let main = &idx.categories[0].chapters[0];
        assert_eq!(main.activity_name.as_deref(), Some("黑暗时代·上"));
        assert_eq!(main.name, "主线");

        let act = &idx.categories[1].chapters;
        // Rowspan group: the group is the activity, the event is the leaf.
        assert_eq!(act[0].activity_name.as_deref(), Some("集成战略"));
        assert_eq!(act[0].name, "刻俄柏的灰蕈迷境");
        // Continuation row inherits the remembered group as its activity.
        assert_eq!(act[1].activity_name.as_deref(), Some("集成战略"));
        assert_eq!(act[1].name, "傀影与猩红孤钻");
        // Standalone row after a group must NOT inherit the stale group.
        assert_eq!(act[2].activity_name.as_deref(), Some("骑兵与猎人"));
        assert_eq!(act[2].name, "支线");
    }
}
