import { usesHttpLocalhostScheme } from "./platform";

// Wiki CDN domains that must be proxied through the prts-cdn:// protocol.
export const WIKI_CDN_DOMAINS = [
  "static.prts.wiki",
  "media.prts.wiki",
  "torappu.prts.wiki",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
];

const ASSET_PATH = /(?:\/(?:assets|music|npm)\/|\.(?:avif|bmp|css|gif|jpe?g|js|m4a|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?)(?:[?#]|$))/i;

/**
 * Learn asset hosts from the current PRTS snapshot instead of assuming the wiki
 * will use the same CDN names forever. Only asset-looking URLs are admitted, so
 * unrelated links/API endpoints embedded in upstream JavaScript stay untouched.
 */
export function discoverAssetDomains(...texts: string[]): string[] {
  const domains = new Set(WIKI_CDN_DOMAINS);
  const url = /https?:\/\/([^/\s"'`<>]+)(\/[^\s"'`<>]*)?/gi;
  for (const text of texts) {
    for (const match of text.matchAll(url)) {
      const host = match[1].toLowerCase().replace(/:\d+$/, "");
      const path = match[2] || "/";
      if (ASSET_PATH.test(path)) domains.add(host);
    }
  }
  return Array.from(domains);
}

// Chromium-based WebViews (Windows WebView2, Android system WebView) serve the
// custom scheme at http://{scheme}.localhost; WebKitGTK/WKWebView use {scheme}://.
export const PROXY_BASE = usesHttpLocalhostScheme()
  ? "http://prts-cdn.localhost"
  : "prts-cdn://localhost";

/** Rewrite a single CDN URL to the proxy protocol. */
export function proxyUrl(url: string, domains: readonly string[] = WIKI_CDN_DOMAINS): string {
  for (const domain of domains) {
    if (url.startsWith(`https://${domain}/`)) {
      return `${PROXY_BASE}/${domain}/${url.substring(`https://${domain}/`.length)}`;
    }
    if (url.startsWith(`http://${domain}/`)) {
      return `${PROXY_BASE}/${domain}/${url.substring(`http://${domain}/`.length)}`;
    }
  }
  return url;
}

/** Rewrite ALL CDN URLs in a text block (HTML/CSS/JS) to proxy URLs. */
export function rewriteAllCdnUrls(text: string, domains: readonly string[] = WIKI_CDN_DOMAINS): string {
  for (const domain of domains) {
    text = text.replaceAll(`https://${domain}/`, `${PROXY_BASE}/${domain}/`);
    text = text.replaceAll(`http://${domain}/`, `${PROXY_BASE}/${domain}/`);
  }
  return text;
}
