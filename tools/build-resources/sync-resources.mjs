#!/usr/bin/env node
// Dependency-free probe; image tools and Cheerio are needed only on an update.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = "https://prts.wiki/api.php";
const ASSETS = "https://api.github.com/repos/ArknightsAssets/ArknightsAssets2/contents/assets/dyn/arts/ui/mixstory/kvs?ref=cn";
const RAW = "https://raw.githubusercontent.com/djkcyl/arkstage/resources/";
const RECIPE = 1;
const UA = "ArkstageResourceSync/2 (+https://github.com/djkcyl/arkstage)";
const hash = (data) => createHash("sha256").update(data).digest("hex");
const stable = (value) => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const sanitize = (s) => s.replace(/[/\\:*?"<>|]/g, "_");
const json = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; } };
const writeJson = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n"); };
function api(params) { return `${API}?${new URLSearchParams({ format: "json", ...params })}`; }

export async function pool(items, task, concurrency = 4) {
  const result = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await task(items[index], index); }
  }));
  return result;
}

export function normalizeActivities(body) {
  const results = body.query?.results;
  if (!results || typeof results !== "object" || Object.keys(results).length < 20) throw new Error("Incomplete PRTS activity query");
  return Object.values(results).flatMap(row => {
    const p = row.printouts, categories = p?.["分类"]?.map(c => c.fulltext) ?? [];
    const title = p?.["名称"]?.[0] || row.fulltext, short = p?.["名称缩短"]?.[0] || row.fulltext;
    if (!categories.some(c => /支线故事|故事集|联动活动/.test(c)) && !/SideStory|故事集/.test(title)) return [];
    return [{ title: row.fulltext, short, file: p?.["标题图文件名"]?.[0] ?? null, collab: categories.includes("分类:联动活动") }];
  }).sort((a, b) => a.title.localeCompare(b.title));
}

export function makeClient(fetcher = fetch, oldRequests = {}) {
  const requests = {}; let count = 0, bytes = 0;
  async function get(url, normalize = value => value, optional = false) {
    const prior = oldRequests[url];
    const headers = { "User-Agent": UA, Referer: "https://prts.wiki/" };
    if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    if (prior?.etag) headers["If-None-Match"] = prior.etag;
    else if (prior?.modified) headers["If-Modified-Since"] = prior.modified;
    count++;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (response.status === 304 && prior) { requests[url] = prior; return prior.value; }
    if (response.status === 404 && optional) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const text = await response.text(); bytes += Buffer.byteLength(text);
    const body = JSON.parse(text);
    if (body.error) throw new Error(`Upstream API error: ${JSON.stringify(body.error)}`);
    const value = normalize(body);
    requests[url] = { etag: response.headers.get("etag"), modified: response.headers.get("last-modified"), value };
    return value;
  }
  return { get, requests, stats: () => ({ requests: count, bytes }) };
}

export async function probe({ base, work = path.join(ROOT, "build/resource-sync"), fetcher = fetch } = {}) {
  const start = performance.now();
  const baseline = base ? await json(path.join(base, "automation-state.json"), null)
    : await makeClient(fetcher).get(`${RAW}automation-state.json`, value => value, true);
  const maps = {};
  for (const [key, file] of Object.entries({ kv: "kv-map.json", covers: "activity-banner-covers.json", banners: "chapter-banner-map.json" })) {
    maps[key] = await json(path.join(ROOT, "tools/extract-covers", file));
  }
  const recipeHash = hash(stable({ recipe: RECIPE, maps,
    code: await fs.readFile(fileURLToPath(import.meta.url), "utf8"),
    parser: await fs.readFile(path.join(ROOT, "tools/gen-index/resource-parsers.mjs"), "utf8"),
    license: await fs.readFile(path.join(ROOT, "LICENSE"), "utf8"),
    scope: await fs.readFile(path.join(ROOT, "LICENSE-SCOPE.md"), "utf8"),
  }));
  const client = makeClient(fetcher, baseline?.requests);
  const [revisions, activities, kvs] = await Promise.all([
    client.get(api({ action: "query", prop: "revisions", rvprop: "ids", titles: "关卡一览/曲谱|剧情一览", formatversion: "2" }), body => {
      const pages = body.query?.pages;
      if (!Array.isArray(pages) || pages.length !== 2 || pages.some(p => !p.revisions?.[0]?.revid)) throw new Error("Incomplete wiki revision response");
      return Object.fromEntries(pages.map(p => [p.title, p.revisions[0].revid]));
    }),
    client.get(api({ action: "ask", query: "[[分类:有活动信息的页面]]|?名称|?名称缩短|?标题图文件名|?分类|limit=500" }), normalizeActivities),
    client.get(ASSETS, body => {
      if (!Array.isArray(body) || body.length < 20) throw new Error("Incomplete KV directory response");
      return Object.fromEntries(body.filter(f => /^kv_.+\.png$/.test(f.name)).map(f => [f.name.slice(3, -4), { sha: f.sha, url: f.download_url }]));
    }),
  ]);
  const files = [...new Set([...Object.values(maps.covers), ...Object.values(maps.banners), ...activities.map(a => a.file).filter(Boolean)])].sort();
  const images = {};
  await pool(Array.from({ length: Math.ceil(files.length / 50) }, (_, i) => files.slice(i * 50, i * 50 + 50)), async names => {
    const entries = await client.get(api({ action: "query", prop: "imageinfo", iiprop: "url|sha1|size", titles: names.map(name => `File:${name}`).join("|"), formatversion: "2" }), body => {
      if (!Array.isArray(body.query?.pages)) throw new Error("Incomplete image metadata response");
      return body.query.pages.map(page => ({ name: page.title.replace(/^(File|文件):/, ""), info: page.imageinfo?.[0] ?? null }));
    });
    for (const { name, info } of entries) { images[name] = info; images[name.replaceAll("_", " ")] = info; }
  });
  // Re-uploading an existing file changes its SHA even when the wiki page's
  // revision and the filename do not change.
  const inputs = { revisions, activities, kvs, images };
  const fingerprint = hash(stable({ recipeHash, inputs }));
  const changed = baseline?.fingerprint !== fingerprint;
  const result = { schemaVersion: 1, fingerprint, recipeHash, inputs, requests: client.requests, changed, maps };
  await writeJson(path.join(work, "probe.json"), result);
  const stats = { changed, elapsedMs: Math.round(performance.now() - start), ...client.stats() };
  console.log(JSON.stringify({ stage: "probe", ...stats }));
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  return { ...result, stats };
}

function safeArtPath(root, relative) {
  if (!/^(covers|banners)\/[a-f\d]{20}\.webp$/.test(relative)) throw new Error(`Invalid resource path: ${relative}`);
  return path.join(root, relative);
}
async function reuseArt(base, entry) {
  if (!base || !entry) return false;
  try { const bytes = await fs.readFile(safeArtPath(base, entry.path)); return hash(bytes).slice(0, 20) === path.basename(entry.path, ".webp"); } catch { return false; }
}

export async function update({ base, out, work = path.join(ROOT, "build/resource-sync"), fetcher = fetch, convert } = {}) {
  if (!base || !out || path.resolve(base) === path.resolve(out)) throw new Error("--base and a separate --out directory are required");
  const plan = await json(path.join(work, "probe.json"));
  const previous = await json(path.join(base, "metadata.json"));
  const oldState = await json(path.join(base, "automation-state.json"), {});
  const { parseIndex, parseTaxonomy } = await import("../gen-index/resource-parsers.mjs");
  async function wiki(title, raw = false) {
    const response = await fetcher(`https://prts.wiki/w/${encodeURIComponent(title)}${raw ? "?action=raw" : ""}`, { headers: { "User-Agent": UA, Referer: "https://prts.wiki/" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${title}`);
    return response.text();
  }
  const [html, raw] = await Promise.all([wiki("剧情一览"), wiki("关卡一览/曲谱", true)]);
  const index = parseIndex(html);
  const storylines = parseTaxonomy(raw, index, plan.inputs.activities, previous.storylines);
  const recipe = { ...plan.maps.banners };
  const activities = new Map(plan.inputs.activities.map(a => [a.short || a.title, a]));
  for (const book of index.books) if (activities.get(book)?.file) recipe[book] = activities.get(book).file;
  const kvBooks = new Map(Object.entries(plan.maps.kv).map(([kv, book]) => [book, kv]));
  const specs = [];
  for (const book of new Set([...Object.keys(previous.covers), ...index.books, ...kvBooks.keys()])) {
    const kv = kvBooks.get(book), file = plan.maps.covers[book] || recipe[book];
    if (kv && plan.inputs.kvs[kv]) specs.push({ kind: "covers", book, source: { type: "kv", ...plan.inputs.kvs[kv] }, width: 420, quality: 80 });
    else if (file && plan.inputs.images[file]) specs.push({ kind: "covers", book, source: { type: "wiki", ...plan.inputs.images[file] }, width: 480, quality: 82 });
  }
  for (const [book, file] of Object.entries(recipe)) if (plan.inputs.images[file]) specs.push({ kind: "banners", book, source: { type: "wiki", ...plan.inputs.images[file] }, width: 560, quality: 78 });
  await fs.mkdir(out, { recursive: true });
  // Preserve valid published art when its source is temporarily absent; API
  // failures themselves abort the probe and can never erase the old branch.
  const covers = {}, banners = {}, artwork = {};
  for (const kind of ["covers", "banners"]) {
    await fs.mkdir(path.join(out, kind), { recursive: true });
    for (const [book, entry] of Object.entries(previous[kind])) {
      if (!(await reuseArt(base, entry))) throw new Error(`Published image missing/corrupt: ${entry.path}`);
      await fs.copyFile(safeArtPath(base, entry.path), safeArtPath(out, entry.path));
      (kind === "covers" ? covers : banners)[book] = entry;
    }
  }
  let downloaded = 0, reused = 0;
  const downloads = new Map();
  await pool(specs, async spec => {
    const key = `${spec.kind}/${spec.book}`, signature = hash(stable({ source: { type: spec.source.type, sha: spec.source.sha || spec.source.sha1 }, width: spec.width, quality: spec.quality, recipe: RECIPE }));
    const old = oldState.artwork?.[key], target = spec.kind === "covers" ? covers : banners;
    if (old?.signature === signature && await reuseArt(base, old.entry)) { target[sanitize(spec.book)] = old.entry; artwork[key] = old; reused++; return; }
    const { source } = spec;
    const sourceId = source.sha || source.sha1;
    let download = downloads.get(sourceId);
    if (!download) {
      download = (async () => {
        const response = await fetcher(source.url, { headers: { "User-Agent": UA, Referer: "https://prts.wiki/" }, signal: AbortSignal.timeout(45_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${source.url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const actual = createHash("sha1").update(source.type === "kv" ? Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]) : bytes).digest("hex");
        if (actual !== sourceId) throw new Error(`Source changed during sync: ${spec.book}`);
        downloaded++; return bytes;
      })();
      downloads.set(sourceId, download);
    }
    const bytes = await download;
    const scratch = path.join(work, "images", hash(key)); await fs.mkdir(path.dirname(scratch), { recursive: true });
    let processed;
    if (convert) processed = await convert(bytes, spec);
    else {
      await fs.writeFile(scratch, bytes);
      execFileSync("convert", [scratch, "-resize", `${spec.width}x>`, "-quality", String(spec.quality), `webp:${scratch}.webp`]);
      const [width, height] = execFileSync("identify", ["-format", "%w %h", `${scratch}.webp`]).toString().trim().split(" ").map(Number);
      processed = { bytes: await fs.readFile(`${scratch}.webp`), width, height };
    }
    const relative = `${spec.kind}/${hash(processed.bytes).slice(0, 20)}.webp`;
    await fs.writeFile(safeArtPath(out, relative), processed.bytes);
    const entry = { path: relative, width: processed.width, height: processed.height };
    target[sanitize(spec.book)] = entry; artwork[key] = { signature, entry };
  });
  for (const book of ["集成战略", "生息演算"]) if (covers[book]) {
    const entry = { ...covers[book], path: covers[book].path.replace(/^covers\//, "banners/") };
    await fs.copyFile(safeArtPath(out, covers[book].path), safeArtPath(out, entry.path)); banners[book] = entry;
  }
  const payload = { schemaVersion: 1, version: "", storylines, covers, banners, fallbackCategory: previous.fallbackCategory || "特殊&未分类", scenarioLinks: previous.scenarioLinks || {} };
  payload.version = hash(stable(payload)).slice(0, 20);
  // Do not publish a new SS without its art, or silently unclassify previously
  // classified books. Wait for the upstream data to be completed instead.
  const classified = new Set(storylines.flatMap(([, books]) => books));
  for (const [, books] of previous.storylines) for (const book of books) {
    if (index.books.includes(book) && !classified.has(book)) throw new Error(`Previously classified book lost its category: ${book}`);
  }
  for (const activity of plan.inputs.activities) if (index.books.includes(activity.short) && !previous.covers[sanitize(activity.short)]) {
    if (!classified.has(activity.short) || !covers[sanitize(activity.short)] || !banners[sanitize(activity.short)]) throw new Error(`New story incomplete: ${activity.short}`);
  }
  const used = new Set([...Object.values(covers), ...Object.values(banners)].map(e => e.path));
  for (const kind of ["covers", "banners"]) for (const name of await fs.readdir(path.join(out, kind))) if (!used.has(`${kind}/${name}`)) await fs.unlink(path.join(out, kind, name));
  await writeJson(path.join(out, "metadata.json"), payload);
  await writeJson(path.join(out, "automation-state.json"), { schemaVersion: 1, fingerprint: plan.fingerprint, recipeHash: plan.recipeHash, requests: plan.requests, artwork, metadataVersion: payload.version });
  for (const file of ["LICENSE", "LICENSE-SCOPE.md"]) await fs.copyFile(path.join(ROOT, file), path.join(out, file));
  await fs.writeFile(path.join(out, "README.md"), "# Arkstage runtime resources\n\nGenerated incrementally by tools/build-resources/sync-resources.mjs.\n\n项目原创的索引与分类整理采用 AGPL-3.0-only，见 LICENSE。来自 PRTS、鹰角网络及其他第三方的图片和素材不在该授权范围内，权利归各自权利人所有；下载、浏览及其他使用行为的责任说明见 LICENSE-SCOPE.md。\n");
  console.log(JSON.stringify({ stage: "update", downloaded, reused, covers: Object.keys(covers).length, banners: Object.keys(banners).length, version: payload.version }));
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).filter(s => s.startsWith("--") && s.includes("=")).map(s => [s.slice(2, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
  const options = { base: args.base && path.resolve(args.base), out: args.out && path.resolve(args.out), work: args.work && path.resolve(args.work) };
  try {
    if (process.argv.includes("--update")) await update(options);
    else await probe(options);
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
