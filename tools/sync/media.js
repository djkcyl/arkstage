// Map canonical keys back to prts URLs and download them into the mirror tree,
// under a global throttle that protects prts.wiki.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createLimiter, createTokenBucket, sleep } from "./throttle.js";

const USER_AGENT =
  "ArkstageSync/0.1 (+https://github.com/djkcyl/prts-reader) Node puppeteer-core";

// GLOBAL throttle for ALL prts media downloads:
//   ≤2 concurrent requests, AND total throughput < 5 MB/s.
const MEDIA_CONCURRENCY = 2;
const MAX_BYTES_PER_SEC = 5 * 1024 * 1024; // 5 MB/s
const mediaLimiter = createLimiter(MEDIA_CONCURRENCY);
const bucket = createTokenBucket(MAX_BYTES_PER_SEC);

/**
 * Build the prts fetch URL for a canonical key. The key is `{host}/{path}`; we
 * https:// it and per-segment-encode the path (host left as-is — it's already a
 * lowercase dotted domain).
 * @param {string} key canonical key e.g. "media.prts.wiki/1/10/Avg_071_mini01.png"
 * @returns {string} https URL
 */
export function keyToPrtsUrl(key) {
  const segs = key.split("/");
  const host = segs[0];
  const path_ = segs
    .slice(1)
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `https://${host}/${path_}`;
}

/**
 * Download a single canonical key's media into `<outDir>/media/<key>`, creating
 * dirs. Skips if the file already exists. Returns { skipped, bytes }.
 * @param {string} key canonical key
 * @param {string} outDir mirror root (the file lands under outDir/media/<key>)
 * @returns {Promise<{ key: string, skipped: boolean, bytes: number, ok: boolean, error?: string }>}
 */
export function downloadKey(key, outDir) {
  return mediaLimiter(async () => {
    const dest = path.join(outDir, "media", ...key.split("/"));
    try {
      const st = await fs.stat(dest);
      if (st.isFile() && st.size > 0) {
        return { key, skipped: true, bytes: st.size, ok: true };
      }
    } catch {
      // not present — download
    }

    const url = keyToPrtsUrl(key);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Referer: "https://prts.wiki/" },
          signal: AbortSignal.timeout(60_000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        // Rate-limit on the bytes actually received.
        await bucket.take(buf.length);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        return { key, skipped: false, bytes: buf.length, ok: true };
      } catch (e) {
        lastErr = e;
        await sleep(700 * (attempt + 1));
      }
    }
    return {
      key,
      skipped: false,
      bytes: 0,
      ok: false,
      error: String(lastErr?.message || lastErr),
    };
  });
}
