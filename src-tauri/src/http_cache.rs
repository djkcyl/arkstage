//! Conditional GETs for mutable upstream files. Validators are bound to the
//! validated local bytes: a missing/corrupt cache can never be served via 304.
use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
pub struct Validators {
    sha256: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

pub struct FetchResult {
    pub bytes: Vec<u8>,
    pub not_modified: bool,
    validators: Validators,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validator_path(url: &str) -> PathBuf {
    crate::data_root::data_root()
        .join("cache/http-validators")
        .join(format!("{}.json", digest(url.as_bytes())))
}

pub async fn fetch(url: &str, cached: Option<&[u8]>) -> Result<FetchResult, String> {
    let validators = std::fs::read(validator_path(url))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    fetch_with(crate::net::client(), url, cached, validators).await
}

async fn fetch_with(
    client: &reqwest::Client,
    url: &str,
    cached: Option<&[u8]>,
    old: Validators,
) -> Result<FetchResult, String> {
    let mut request = client.get(url).header("Referer", "https://prts.wiki/");
    let reusable = cached.is_some_and(|bytes| digest(bytes) == old.sha256);
    if reusable {
        if let Some(etag) = &old.etag {
            request = request.header(IF_NONE_MATCH, etag);
        } else if let Some(modified) = &old.last_modified {
            request = request.header(IF_MODIFIED_SINCE, modified);
        }
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return if reusable {
            Ok(FetchResult {
                bytes: cached.unwrap().to_vec(),
                not_modified: true,
                validators: old,
            })
        } else {
            Err("Upstream returned 304 without a matching local cache".into())
        };
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}: {url}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|len| len > 32 * 1024 * 1024)
    {
        return Err("Upstream response is too large".into());
    }
    let header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let mut validators = Validators {
        etag: header(ETAG),
        last_modified: header(LAST_MODIFIED),
        ..Default::default()
    };
    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Upstream response is too large".into());
    }
    validators.sha256 = digest(&bytes);
    let not_modified = cached.is_some_and(|old| old == bytes);
    Ok(FetchResult {
        bytes,
        not_modified,
        validators,
    })
}

/// Call only after the body passed validation and was committed to local storage.
pub fn remember(url: &str, result: &FetchResult) {
    if let Ok(bytes) = serde_json::to_vec(&result.validators) {
        let path = validator_path(url);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn validators_require_matching_bytes_and_304_reuses_body() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/data.json", server.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            for conditional in [true, false] {
                let (mut stream, _) = server.accept().unwrap();
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                assert_eq!(request.contains("if-none-match: \"v1\""), conditional);
                let response = if conditional {
                    "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nETag: \"v2\"\r\nConnection: close\r\n\r\n{}"
                };
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let old = || Validators {
            sha256: digest(b"{\"old\":1}"),
            etag: Some("\"v1\"".into()),
            last_modified: None,
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let reused = fetch_with(&client, &url, Some(b"{\"old\":1}"), old())
            .await
            .unwrap();
        assert!(reused.not_modified);
        assert_eq!(reused.bytes, b"{\"old\":1}");
        let changed = fetch_with(&client, &url, Some(b"corrupt"), old())
            .await
            .unwrap();
        assert!(!changed.not_modified);
        assert_eq!(changed.bytes, b"{}");
        handle.join().unwrap();
    }
}
