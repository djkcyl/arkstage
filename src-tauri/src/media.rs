use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Resolve the content-addressed media store root: `$APPDATA/<identifier>/media`.
/// The protocol handler runs without an AppHandle, so the app data dir is passed in.
pub fn media_root(app_data: &Path) -> PathBuf {
    app_data.join("media")
}

/// Build the prts.wiki fetch URL for a canonical key (`{host}/{path}`): https-prefix
/// it and percent-encode each path segment (the host is already a lowercase dotted
/// domain). Media is always fetched straight from prts.
pub fn prts_url(key: &str) -> String {
    let encoded = key
        .split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    format!("https://{}", encoded)
}

/// Normalize EITHER a full `http(s)://host/path…` URL OR a bare `host/path…` key
/// into the canonical asset key `{host}/{path}` (query/fragment dropped). This is
/// the content-addressed store key, the cross-source dedup key, AND the basis for
/// building per-source fetch URLs — so it must be byte-identical to the old
/// `url_to_relpath` for ordinary ASCII lowercase-host URLs (the existing on-disk
/// cache must NOT be orphaned). Returns None for non-http(s)/schemed strings or
/// inputs without a real domain host + at least one path segment.
pub(crate) fn canonical_key(s: &str) -> Option<String> {
    let rest = if let Some(r) = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
    {
        r
    } else if s.contains(':') {
        // No scheme but a colon → some other scheme (data:/blob:/prts-cdn:/ftp:…).
        return None;
    } else {
        s
    };
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);

    let mut segs: Vec<String> = Vec::new();
    for raw in rest.split('/') {
        // Percent-decode once; on error keep the raw segment.
        let decoded = urlencoding::decode(raw)
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| raw.to_string());
        // A `%2F`/`%5C` that decoded to a separator must not introduce new path
        // levels (anti-traversal) — collapse them to `_`.
        let seg = decoded.replace(['/', '\\'], "_");
        // Skip empties and traversal segments AFTER decoding.
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        segs.push(seg);
    }

    if segs.len() < 2 {
        return None;
    }
    // Lowercase the host (first) segment only; require it to be a real domain.
    segs[0] = segs[0].to_lowercase();
    if !segs[0].contains('.') {
        return None;
    }
    Some(segs.join("/"))
}

/// Map a URL or bare key to a relative store path `{host}/{path}`, sanitized so it
/// cannot escape the store root. Returns None for unmappable inputs.
pub fn url_to_relpath(url: &str) -> Option<PathBuf> {
    canonical_key(url).map(|k| k.split('/').collect::<PathBuf>())
}

/// Absolute path inside the media store for a given URL, or None if URL is unmappable.
pub fn store_path(media_root: &Path, url: &str) -> Option<PathBuf> {
    url_to_relpath(url).map(|rel| media_root.join(rel))
}

/// Read bytes from the store if present.
#[cfg(test)]
pub fn read_local(media_root: &Path, url: &str) -> Option<Vec<u8>> {
    let p = store_path(media_root, url)?;
    std::fs::read(&p).ok()
}

/// Read only a plausible asset. Interrupted writes and CDN error pages used to be
/// cached forever under `.png`/CG keys; remove those so the protocol can refetch.
pub fn read_local_validated(media_root: &Path, url: &str) -> Option<Vec<u8>> {
    let p = store_path(media_root, url)?;
    recover_previous(&p);
    let bytes = std::fs::read(&p).ok()?;
    if validate_asset_bytes(url, &bytes).is_ok() {
        Some(bytes)
    } else {
        let _ = std::fs::remove_file(p);
        None
    }
}

/// Reject successful HTTP responses that are actually HTML error/challenge pages,
/// and verify image magic independently of the extension (PNG keys may hold WebP
/// after local compression).
pub fn validate_asset_bytes(url: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("empty response".into());
    }
    let prefix = &bytes[..bytes.len().min(256)];
    let prefix_text = String::from_utf8_lossy(prefix).to_ascii_lowercase();
    if prefix_text.contains("<!doctype html") || prefix_text.contains("<html") {
        return Err("upstream returned HTML instead of media".into());
    }

    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    let image_key = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]
        .iter()
        .any(|ext| path.ends_with(ext));
    if image_key {
        let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        let is_jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
        let is_gif = bytes.starts_with(b"GIF8");
        let is_webp = bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
        let is_bmp = bytes.starts_with(b"BM");
        let is_avif = bytes.len() >= 12 && &bytes[4..8] == b"ftyp";
        if !(is_png || is_jpeg || is_gif || is_webp || is_bmp || is_avif) {
            return Err("invalid image signature".into());
        }
    }
    Ok(())
}

/// Write bytes to the store, creating parent dirs.
pub fn write_local(media_root: &Path, url: &str, bytes: &[u8]) -> Result<(), String> {
    let p = store_path(media_root, url).ok_or_else(|| "unmappable url".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = p.with_extension(format!("part-{}-{seq}", std::process::id()));
    let backup = p.with_extension("previous");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&backup);
    let had_old = p.exists();
    if had_old {
        std::fs::rename(&p, &backup).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &p).map_err(|e| {
        if had_old {
            let _ = std::fs::rename(&backup, &p);
        }
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    if had_old {
        let _ = std::fs::remove_file(backup);
    }
    Ok(())
}

fn recover_previous(path: &Path) {
    let backup = path.with_extension("previous");
    if !path.exists() && backup.exists() {
        let _ = std::fs::rename(backup, path);
    }
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
    fn http_and_https_yield_the_same_key() {
        assert_eq!(
            canonical_key("http://media.prts.wiki/a/b.png"),
            canonical_key("https://media.prts.wiki/a/b.png")
        );
    }

    #[test]
    fn host_is_lowercased_but_path_case_preserved() {
        assert_eq!(
            canonical_key("https://Media.PRTS.Wiki/A/Avg_X.png").unwrap(),
            "media.prts.wiki/A/Avg_X.png"
        );
    }

    #[test]
    fn percent_encoded_and_literal_traversal_blocked() {
        // %2e%2e decodes to ".." which is dropped, not used to climb out.
        assert_eq!(
            canonical_key("https://media.prts.wiki/a/%2e%2e/b.png").unwrap(),
            "media.prts.wiki/a/b.png"
        );
        assert_eq!(
            canonical_key("https://media.prts.wiki/a/../b.png").unwrap(),
            "media.prts.wiki/a/b.png"
        );
        // %2F inside a segment must NOT introduce a new path level.
        assert_eq!(
            canonical_key("https://media.prts.wiki/a%2Fevil/b.png").unwrap(),
            "media.prts.wiki/a_evil/b.png"
        );
    }

    #[test]
    fn bare_key_is_accepted() {
        assert_eq!(
            canonical_key("media.prts.wiki/a/b.png").unwrap(),
            "media.prts.wiki/a/b.png"
        );
    }

    #[test]
    fn data_uri_is_rejected() {
        assert!(canonical_key("data:image/png;base64,xx").is_none());
    }

    #[test]
    fn single_segment_or_dotless_host_rejected() {
        assert!(canonical_key("https://x").is_none()); // single segment
        assert!(canonical_key("localhost/a/b").is_none()); // dotless host
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

    #[test]
    fn rejects_html_cached_as_cg_and_removes_it() {
        let root = std::env::temp_dir().join(format!("prts_media_bad_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let url = "https://media.prts.wiki/a/ab/CG.png";
        write_local(&root, url, b"<!doctype html><title>rate limited</title>").unwrap();
        assert!(read_local_validated(&root, url).is_none());
        assert!(!store_path(&root, url).unwrap().exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recovers_previous_file_after_interrupted_replace() {
        let root = std::env::temp_dir().join(format!("prts_media_recover_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let url = "https://media.prts.wiki/a/ab/CG.png";
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        write_local(&root, url, &png).unwrap();
        let path = store_path(&root, url).unwrap();
        std::fs::rename(&path, path.with_extension("previous")).unwrap();
        assert_eq!(read_local_validated(&root, url).unwrap(), png);
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
