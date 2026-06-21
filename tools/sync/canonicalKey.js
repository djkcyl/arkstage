// Port of `canonical_key` from src-tauri/src/media.rs — MUST stay byte-identical so
// the Rust app and this tool agree on the content-addressed store key.
//
// Normalize EITHER a full `http(s)://host/path…` URL OR a bare `host/path…` key
// into `{host}/{path}` (query/fragment dropped, host lowercased, percent-decoded
// once, anti-traversal collapsed, require ≥2 segments + dotted host).
// Returns null for non-http(s)/schemed strings or inputs without a real domain
// host + at least one path segment.

/**
 * Percent-decode a single path segment ONCE. On malformed input keep the raw
 * segment (mirrors Rust `urlencoding::decode(...).unwrap_or(raw)`).
 * @param {string} raw
 * @returns {string}
 */
function decodeOnce(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * @param {string} s a full URL or bare key
 * @returns {string | null} canonical `{host}/{path}` key, or null if unmappable
 */
export function canonicalKey(s) {
  if (typeof s !== "string") return null;

  let rest;
  if (s.startsWith("https://")) {
    rest = s.slice("https://".length);
  } else if (s.startsWith("http://")) {
    rest = s.slice("http://".length);
  } else if (s.includes(":")) {
    // No scheme but a colon → some other scheme (data:/blob:/prts-cdn:/ftp:…).
    return null;
  } else {
    rest = s;
  }

  // Drop query/fragment.
  rest = rest.split(/[?#]/, 1)[0];

  const segs = [];
  for (const raw of rest.split("/")) {
    const decoded = decodeOnce(raw);
    // A `%2F`/`%5C` that decoded to a separator must not introduce new path
    // levels (anti-traversal) — collapse them to `_`.
    const seg = decoded.replace(/[/\\]/g, "_");
    // Skip empties and traversal segments AFTER decoding.
    if (seg === "" || seg === "." || seg === "..") continue;
    segs.push(seg);
  }

  if (segs.length < 2) return null;

  // Lowercase the host (first) segment only; require it to be a real domain.
  segs[0] = segs[0].toLowerCase();
  if (!segs[0].includes(".")) return null;

  return segs.join("/");
}
