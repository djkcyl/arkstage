//! Asset-source abstraction + the jsDelivr-backed manifest provider.
//!
//! Every downloadable asset has a single canonical key (`{host}/{path}`, see
//! [`crate::media::canonical_key`]) which is BOTH the store path AND the dedup
//! key. The *source* decides which mirror to actually fetch that key from:
//!   - [`SourceKind::Jsd`]  → `https://cdn.jsdelivr.net/gh/{repo}@{ref}/{key}`
//!   - [`SourceKind::Prts`] → `https://{key}` (the origin host itself)
//! Because the store path is the canonical key regardless of source, switching
//! source never re-downloads anything already cached.
//!
//! prts traffic is special: whether prts is the primary source or just a
//! per-file fallback from a failed jsd fetch, ALL of it is globally limited to
//! [`PRTS_MAX_CONCURRENCY`] concurrent requests and [`PRTS_RATE_LIMIT_BPS`] bytes
//! per second (the [`prts_gate`] semaphore + [`prts_limiter`] token bucket).
//! jsd traffic is unthrottled (only the user's global net::limiter applies).

use std::sync::{Mutex, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

/// Which mirror to fetch canonical asset keys from.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Jsd,
    Prts,
}

/// Active source configuration (a process-global snapshot lives behind [`CONFIG`]).
pub struct SourceConfig {
    pub kind: SourceKind,
    pub jsd_repo: String,
    pub jsd_ref: String,
    pub jsd_concurrency: usize,
}

impl Clone for SourceConfig {
    fn clone(&self) -> Self {
        SourceConfig {
            kind: self.kind,
            jsd_repo: self.jsd_repo.clone(),
            jsd_ref: self.jsd_ref.clone(),
            jsd_concurrency: self.jsd_concurrency,
        }
    }
}

impl Default for SourceConfig {
    fn default() -> Self {
        SourceConfig {
            kind: SourceKind::Jsd,
            jsd_repo: "djkcyl/arkstage-assets".to_string(),
            jsd_ref: "main".to_string(),
            jsd_concurrency: 8,
        }
    }
}

/// prts hard limits — fixed (not user-settable). prts is a courtesy mirror, so we
/// cap it tightly no matter how it's being used.
pub const PRTS_MAX_CONCURRENCY: usize = 2;
pub const PRTS_RATE_LIMIT_BPS: u64 = 5_000_000;

/// Process-global active source config.
fn config() -> &'static RwLock<SourceConfig> {
    static CONFIG: OnceLock<RwLock<SourceConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| RwLock::new(SourceConfig::default()))
}

/// Snapshot of the current source config.
pub fn current() -> SourceConfig {
    config().read().unwrap().clone()
}

/// Effective worker-pool size for the active source: clamped jsd concurrency, or
/// the fixed prts cap. Part of the Phase 1 source API; `Manager::start` currently
/// inlines the equivalent branch, so this isn't wired into a caller yet.
#[allow(dead_code)]
pub fn effective_concurrency() -> usize {
    let cfg = current();
    match cfg.kind {
        SourceKind::Jsd => cfg.jsd_concurrency.clamp(1, 16),
        SourceKind::Prts => PRTS_MAX_CONCURRENCY,
    }
}

/// Global prts concurrency gate (2 permits). Held across each prts request+body so
/// no more than [`PRTS_MAX_CONCURRENCY`] prts fetches run at once, even when prts
/// is only a per-file fallback while jsd is the primary source.
pub fn prts_gate() -> &'static tokio::sync::Semaphore {
    static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Semaphore::new(PRTS_MAX_CONCURRENCY))
}

/// Global prts bandwidth limiter (5 MB/s). Independent of the user's global
/// net::limiter; prts chunks are metered through BOTH.
pub fn prts_limiter() -> &'static crate::net::RateLimiter {
    static LIMITER: OnceLock<crate::net::RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| crate::net::RateLimiter::new(PRTS_RATE_LIMIT_BPS))
}

/// Percent-encode each `/`-separated segment of a canonical key and rejoin. For
/// pure-ASCII-alnum segments this is the identity; spaces/non-ASCII get encoded so
/// the resulting URL is valid.
fn encode_path(key: &str) -> String {
    key.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Build the actual fetch URL for a canonical key under a given source.
pub fn fetch_url(kind: SourceKind, key: &str, cfg: &SourceConfig) -> String {
    match kind {
        SourceKind::Prts => format!("https://{}", encode_path(key)),
        SourceKind::Jsd => format!(
            "https://cdn.jsdelivr.net/gh/{}@{}/{}",
            cfg.jsd_repo,
            cfg.jsd_ref,
            encode_path(key)
        ),
    }
}

/// Sanitize a story title into a cache/manifest filename the same way cache.rs
/// does (`/\:*?"<>|` → `_`). Replicated here to keep the manifest-key mapping
/// consistent with the on-disk manifest cache.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfigDto {
    pub kind: String,
    pub jsd_repo: String,
    pub jsd_ref: String,
    pub jsd_concurrency: usize,
    pub prts_max_concurrency: usize,
    pub prts_rate_limit_bps: u64,
}

#[tauri::command]
pub fn source_get() -> SourceConfigDto {
    let cfg = current();
    SourceConfigDto {
        kind: match cfg.kind {
            SourceKind::Jsd => "jsd".to_string(),
            SourceKind::Prts => "prts".to_string(),
        },
        jsd_repo: cfg.jsd_repo,
        jsd_ref: cfg.jsd_ref,
        jsd_concurrency: cfg.jsd_concurrency,
        prts_max_concurrency: PRTS_MAX_CONCURRENCY,
        prts_rate_limit_bps: PRTS_RATE_LIMIT_BPS,
    }
}

/// Update only the provided fields. Unknown `kind` strings, empty repo/ref, and
/// out-of-range concurrency are ignored/clamped. The prts limits are fixed.
#[tauri::command]
pub fn source_set(
    kind: Option<String>,
    jsd_repo: Option<String>,
    jsd_ref: Option<String>,
    jsd_concurrency: Option<usize>,
) {
    let mut cfg = config().write().unwrap();
    if let Some(k) = kind {
        match k.as_str() {
            "jsd" => cfg.kind = SourceKind::Jsd,
            "prts" => cfg.kind = SourceKind::Prts,
            _ => {} // ignore unknown
        }
    }
    if let Some(repo) = jsd_repo {
        if !repo.is_empty() {
            cfg.jsd_repo = repo;
        }
    }
    if let Some(r) = jsd_ref {
        if !r.is_empty() {
            cfg.jsd_ref = r;
        }
    }
    if let Some(c) = jsd_concurrency {
        cfg.jsd_concurrency = c.clamp(1, 16);
    }
}

/// Resolved mirror ref, memoized for the process. Resolving once per run is fine —
/// a restart re-resolves and picks up any new pinned ref.
fn resolved_ref_cell() -> &'static Mutex<Option<String>> {
    static REF: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    REF.get_or_init(|| Mutex::new(None))
}

/// Resolve the effective jsd ref: prefer the mirror's pinned `version.json` `ref`,
/// falling back to the configured `jsd_ref` on any failure. Memoized.
async fn resolve_ref(cfg: &SourceConfig) -> String {
    if let Some(r) = resolved_ref_cell().lock().unwrap().clone() {
        return r;
    }
    let url = format!(
        "https://cdn.jsdelivr.net/gh/{}@latest/version.json",
        cfg.jsd_repo
    );
    let resolved = (async {
        let resp = crate::net::client().get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let v: serde_json::Value = resp.json().await.ok()?;
        v.get("ref")?.as_str().map(|s| s.to_string())
    })
    .await
    .unwrap_or_else(|| cfg.jsd_ref.clone());
    *resolved_ref_cell().lock().unwrap() = Some(resolved.clone());
    resolved
}

/// Manifest provider: fetch a story's pre-built asset manifest from the jsd mirror
/// (a JSON array of canonical keys), convert it to the `https://…` URL form the
/// rest of the app's cache pipeline expects, persist it to the manifest cache, and
/// return it. ANY failure (offline, 404, parse error) returns None so the frontend
/// falls back to WebView capture. Never panics.
#[tauri::command]
pub async fn fetch_story_manifest(page_title: String) -> Option<Vec<String>> {
    if !crate::net::allow_online() {
        return None;
    }
    let cfg = current();
    let mirror_ref = resolve_ref(&cfg).await;
    let url = format!(
        "https://cdn.jsdelivr.net/gh/{}@{}/manifests/{}.json",
        cfg.jsd_repo,
        mirror_ref,
        sanitize(&page_title)
    );

    let resp = crate::net::client().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let keys: Vec<String> = resp.json().await.ok()?;
    // Manifests store canonical keys; the local cache + feeder + per-chapter
    // deletion all key off the `https://` URL form, so normalize to that.
    let urls: Vec<String> = keys.into_iter().map(|k| format!("https://{}", k)).collect();

    // Persist so download_feed_cached can drive this story without the WebView.
    let path = crate::commands::cache::manifest_cache_path(&page_title);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&urls) {
        let _ = std::fs::write(&path, json);
    }
    Some(urls)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_url_maps_both_sources() {
        let cfg = SourceConfig {
            kind: SourceKind::Jsd,
            jsd_repo: "djkcyl/arkstage-assets".to_string(),
            jsd_ref: "main".to_string(),
            jsd_concurrency: 8,
        };
        let key = "media.prts.wiki/1/10/Avg_x.png";
        assert_eq!(
            fetch_url(SourceKind::Jsd, key, &cfg),
            "https://cdn.jsdelivr.net/gh/djkcyl/arkstage-assets@main/media.prts.wiki/1/10/Avg_x.png"
        );
        assert_eq!(
            fetch_url(SourceKind::Prts, key, &cfg),
            "https://media.prts.wiki/1/10/Avg_x.png"
        );
    }

    #[test]
    fn encode_path_identity_for_ascii_encodes_others() {
        assert_eq!(encode_path("media.prts.wiki/1/10/Avg_x.png"), "media.prts.wiki/1/10/Avg_x.png");
        // Space encodes; the `/` separators are preserved (per-segment encoding).
        assert_eq!(encode_path("h.x/a b/c"), "h.x/a%20b/c");
        // Non-ASCII encodes too.
        assert_eq!(encode_path("h.x/世界"), "h.x/%E4%B8%96%E7%95%8C");
    }

    #[test]
    fn effective_concurrency_clamps_and_fixes_prts() {
        // prts is always the fixed cap regardless of jsd_concurrency.
        source_set(Some("prts".into()), None, None, Some(16));
        assert_eq!(effective_concurrency(), PRTS_MAX_CONCURRENCY);
        // jsd clamps to [1,16].
        source_set(Some("jsd".into()), None, None, Some(999));
        assert_eq!(effective_concurrency(), 16);
        source_set(None, None, None, Some(0));
        assert_eq!(effective_concurrency(), 1);
        // restore default for other tests in the binary.
        source_set(Some("jsd".into()), None, None, Some(8));
    }

    #[test]
    fn source_set_switches_kind_and_clamps() {
        source_set(Some("prts".into()), None, None, None);
        assert_eq!(current().kind, SourceKind::Prts);
        source_set(Some("nonsense".into()), None, None, None); // ignored
        assert_eq!(current().kind, SourceKind::Prts);
        source_set(Some("jsd".into()), Some(String::new()), None, Some(50));
        let c = current();
        assert_eq!(c.kind, SourceKind::Jsd);
        assert_eq!(c.jsd_concurrency, 16); // clamped
        assert_eq!(c.jsd_repo, "djkcyl/arkstage-assets"); // empty repo ignored
        // restore default.
        source_set(Some("jsd".into()), None, None, Some(8));
    }

    #[test]
    fn prts_limits_are_fixed() {
        assert_eq!(prts_limiter().rate(), 5_000_000);
        assert_eq!(prts_gate().available_permits(), 2);
    }
}
