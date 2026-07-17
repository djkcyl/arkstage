#!/usr/bin/env node
/**
 * End-to-end PRTS ScenarioSimulator audit.
 *
 * Usage:
 *   npm run verify:prts-sync
 *   node scripts/verify-prts-sync.mjs "PAGE TITLE" ...
 *
 * The defaults cover the newest story set that originally exposed the missing
 * sprite/CG bug. CI can pass any future chapter's page titles without code changes.
 */
const DEFAULT_PAGES = [
  "BD-ST1 土壤病/NBT", "BD-ST2 退行性猎犬病/NBT", "BD-ST3 香蕉出血热/NBT",
  "BD-ST4 专性寄生/NBT", "BD-ST5 热病与城/NBT", "BD-ST6 大流行/NBT",
  "BD-ST7 漫游症/NBT",
];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PAGES;
const decode = (s) => s.replaceAll("&quot;", '"').replaceAll("&#39;", "'")
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const pre = (html, id) => {
  const match = html.match(new RegExp(`<pre[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/pre>`));
  if (!match) throw new Error(`missing #${id}`);
  return decode(match[1]);
};
const csv = (text) => new Map(text.split("\n").map((line) => {
  const comma = line.indexOf(",");
  return comma < 0 ? ["", ""] : [line.slice(0, comma).trim().toLowerCase(), line.slice(comma + 1).trim()];
}).filter(([key]) => key));
const params = (text) => {
  const result = {};
  for (const match of text.matchAll(/([a-zA-Z][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/g))
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  return result;
};
async function fetchRetry(url, init = {}) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { Referer: "https://prts.wiki/", "User-Agent": "Arkstage-sync-check/1", ...init.headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw last;
}

const urls = new Set();
let totalReferences = 0;
for (const page of pages) {
  const pageUrl = `https://prts.wiki/w/${encodeURIComponent(page)}`;
  const html = await (await fetchRetry(pageUrl)).text();
  const required = ["datas_txt", "datas_back", "datas_char", "datas_audio", "datas_link"];
  for (const id of required) pre(html, id);
  const script = pre(html, "datas_txt");
  const backgrounds = csv(pre(html, "datas_back"));
  const characters = csv(pre(html, "datas_char"));
  const links = JSON.parse(pre(html, "datas_link"));

  // Mirror the client's forward-compatible datas_char -> datas_link repair.
  const groups = new Map();
  for (const key of characters.keys()) {
    const match = key.match(/^(.+?)(?:-(\d+))?\$(\d+)$/);
    if (!match) continue;
    const entries = groups.get(match[1]) || [];
    entries.push({ name: key, expression: Number(match[2] || 0), group: Number(match[3]) });
    groups.set(match[1], entries);
  }
  let repaired = 0;
  for (const [base, entries] of groups) if (!links[base]) {
    entries.sort((a, b) => a.group - b.group || (a.expression || 9999) - (b.expression || 9999));
    links[base] = { array: entries.map(({ name }) => ({ name })) };
    repaired++;
  }

  const missing = new Set();
  let references = 0;
  const command = /^\s*\[\s*(background|image|showitem|gridbg|verticalbg|largebg|largeimg|character|charactercutin|charslot)\s*(?:\((.*?)\))?\s*\]/gim;
  for (const match of script.matchAll(command)) {
    const type = match[1].toLowerCase();
    const args = params(match[2] || "");
    const imageKeys = [];
    if (["background", "image", "showitem"].includes(type) && args.image)
      imageKeys.push(`${type === "background" ? "bg_" : ""}${args.image.toLowerCase()}`);
    if (["gridbg", "verticalbg", "largebg", "largeimg"].includes(type) && args.imagegroup)
      imageKeys.push(...args.imagegroup.split("/").filter(Boolean)
        .map((image) => `${type.endsWith("bg") ? "bg_" : ""}${image.toLowerCase()}`));
    for (const key of imageKeys) {
      references++;
      if (!backgrounds.has(key)) missing.add(`<${type}> ${key}`);
      else urls.add(backgrounds.get(key));
    }
    if (!["character", "charactercutin", "charslot"].includes(type)) continue;
    for (const raw of [args.name, type === "character" ? args.name2 : null].filter(Boolean)) {
      references++;
      const parsed = raw.trim().toLowerCase().match(/^([^@#$]+)(?:([@#$])([a-z\d]+)|#(\d+)\$(\d+))?$/);
      const link = parsed && links[parsed[1]];
      if (!parsed || !link) { missing.add(`<${type}> ${parsed?.[1] || raw}`); continue; }
      let index = 0;
      if (parsed[4] && parsed[5]) {
        const start = link.array.findIndex((entry) => entry.name.toLowerCase().endsWith(`$${parsed[5]}`));
        index = start < 0 ? 0 : start + Number(parsed[4]) - 1;
      }
      const key = link.array[Math.max(0, Math.min(index, link.array.length - 1))]?.name?.toLowerCase();
      if (!key || !characters.has(key)) missing.add(`<${type}> ${parsed[1]} -> ${key}`);
      else urls.add(characters.get(key));
    }
  }
  totalReferences += references;
  console.log(`${page}: ${references} refs, ${missing.size} missing, ${repaired} repaired link groups`);
  if (missing.size) throw new Error([...missing].join("; "));
}

const media = [...urls];
let cursor = 0;
const failures = [];
async function verifyMedia() {
  while (cursor < media.length) {
    const url = media[cursor++];
    try {
      const response = await fetchRetry(url, { method: "HEAD" });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) failures.push(`${url} (${contentType || "no content-type"})`);
    } catch (error) { failures.push(`${url} (${error})`); }
  }
}
await Promise.all(Array.from({ length: 12 }, verifyMedia));
if (failures.length) throw new Error(`media verification failed:\n${failures.slice(0, 30).join("\n")}`);
console.log(`OK: ${pages.length} pages, ${totalReferences} references, ${media.length} unique image URLs`);
