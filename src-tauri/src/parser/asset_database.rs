use std::collections::HashMap;

use crate::models::{AssetDatabases, OverrideEntry};
use crate::parser::story_page::DataBlocks;

/// Parse the raw data blocks into structured AssetDatabases.
pub fn parse_asset_databases(blocks: DataBlocks) -> AssetDatabases {
    let backgrounds = parse_csv_mapping(&blocks.backgrounds);
    let characters = parse_csv_mapping(&blocks.characters);

    // Audio data is JSON (may have trailing commas or quirks)
    let audio = parse_json_loose(&blocks.audio);

    // Link data is JSON with character positioning
    let link = parse_json_loose(&blocks.link);

    // Override data is line-based key=value
    let overrides = parse_overrides(&blocks.overrides);

    AssetDatabases {
        backgrounds,
        characters,
        audio,
        link,
        overrides,
    }
}

/// Parse CSV-format asset mapping: "key,url\nkey,url\n..."
fn parse_csv_mapping(csv: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in csv.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Split on first comma only (URLs may not contain commas but be safe)
        if let Some((key, url)) = line.split_once(',') {
            let key = key.trim().to_lowercase();
            let url = url.trim().to_string();
            if !key.is_empty() && !url.is_empty() {
                map.insert(key, url);
            }
        }
    }
    map
}

/// Parse JSON that may have quirks like trailing commas.
fn parse_json_loose(json_str: &str) -> serde_json::Value {
    let cleaned = json_str.trim();
    if cleaned.is_empty() {
        return serde_json::Value::Null;
    }

    // Try direct parse first
    if let Ok(val) = serde_json::from_str(cleaned) {
        return val;
    }

    // Try removing trailing commas before } and ]
    let fixed = cleaned
        .replace(",}", "}")
        .replace(",]", "]");
    serde_json::from_str(&fixed).unwrap_or(serde_json::Value::Null)
}

/// Parse override entries: "kind:key=value" per line
fn parse_overrides(text: &str) -> Vec<OverrideEntry> {
    let mut entries = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        // Format: kind:key=value
        if let Some((left, value)) = line.split_once('=') {
            if let Some((kind, key)) = left.split_once(':') {
                entries.push(OverrideEntry {
                    kind: kind.trim().to_string(),
                    key: key.trim().to_string(),
                    value: value.trim().to_string(),
                });
            }
        }
    }
    entries
}
