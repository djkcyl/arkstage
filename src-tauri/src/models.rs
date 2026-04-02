use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryIndex {
    pub categories: Vec<Category>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub name: String,
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub name: String,
    pub stories: Vec<StoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryEntry {
    pub title: String,
    pub page_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryPageData {
    pub script: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetDatabases {
    pub backgrounds: HashMap<String, String>,
    pub characters: HashMap<String, String>,
    pub audio: serde_json::Value,
    pub link: serde_json::Value,
    pub overrides: Vec<OverrideEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverrideEntry {
    pub kind: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStatus {
    pub story_index_cached: bool,
    pub asset_db_cached: bool,
    pub cached_stories: Vec<String>,
    pub total_size_bytes: u64,
}

/// The original widget engine bundle: DOM + data blocks + inline scripts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetBundleData {
    pub dom_html: String,
    pub data_blocks_html: String,
    pub engine_scripts: Vec<String>,
}
