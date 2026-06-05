use std::path::{Path, PathBuf};

/// Resolve the content-addressed media store root: `$APPDATA/<identifier>/media`.
/// The protocol handler runs without an AppHandle, so the app data dir is passed in.
pub fn media_root(app_data: &Path) -> PathBuf {
    app_data.join("media")
}

/// Map an absolute CDN URL to a relative store path `{host}/{path}` (query/fragment
/// dropped), sanitized so it cannot escape the store root. Returns None for
/// non-http(s) URLs or URLs without at least a host + one path segment.
pub fn url_to_relpath(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::new();
    for seg in rest.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        out.push(seg);
    }
    if out.components().count() < 2 {
        return None;
    }
    Some(out)
}

/// Absolute path inside the media store for a given URL, or None if URL is unmappable.
pub fn store_path(media_root: &Path, url: &str) -> Option<PathBuf> {
    url_to_relpath(url).map(|rel| media_root.join(rel))
}

/// Read bytes from the store if present.
pub fn read_local(media_root: &Path, url: &str) -> Option<Vec<u8>> {
    let p = store_path(media_root, url)?;
    std::fs::read(&p).ok()
}

/// Write bytes to the store, creating parent dirs.
pub fn write_local(media_root: &Path, url: &str, bytes: &[u8]) -> Result<(), String> {
    let p = store_path(media_root, url).ok_or_else(|| "unmappable url".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_media_url_to_host_path() {
        assert_eq!(
            url_to_relpath("https://media.prts.wiki/1/10/Avg_071_mini01.png").unwrap(),
            PathBuf::from("media.prts.wiki/1/10/Avg_071_mini01.png")
        );
    }

    #[test]
    fn drops_query_and_blocks_traversal() {
        assert_eq!(
            url_to_relpath("https://static.prts.wiki/a/../../etc/passwd?x=1").unwrap(),
            PathBuf::from("static.prts.wiki/a/etc/passwd")
        );
    }

    #[test]
    fn rejects_non_http() {
        assert!(url_to_relpath("ftp://x/y").is_none());
        assert!(url_to_relpath("prts-cdn://localhost/a").is_none());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let root = std::env::temp_dir().join(format!("prts_media_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let url = "https://media.prts.wiki/a/ab/Test.png";
        write_local(&root, url, b"hello").unwrap();
        assert_eq!(read_local(&root, url).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&root);
    }
}
