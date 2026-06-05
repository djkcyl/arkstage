// Wiki CDN domains that must be proxied through the prts-cdn:// protocol.
export const WIKI_CDN_DOMAINS = [
  "static.prts.wiki",
  "media.prts.wiki",
  "torappu.prts.wiki",
];

// On Windows WebView2 the custom scheme is served at http://{scheme}.localhost.
export const PROXY_BASE = navigator.userAgent.includes("Windows")
  ? "http://prts-cdn.localhost"
  : "prts-cdn://localhost";

/** Rewrite a single CDN URL to the proxy protocol. */
export function proxyUrl(url: string): string {
  for (const domain of WIKI_CDN_DOMAINS) {
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
export function rewriteAllCdnUrls(text: string): string {
  for (const domain of WIKI_CDN_DOMAINS) {
    text = text.replaceAll(`https://${domain}/`, `${PROXY_BASE}/${domain}/`);
    text = text.replaceAll(`http://${domain}/`, `${PROXY_BASE}/${domain}/`);
  }
  return text;
}
