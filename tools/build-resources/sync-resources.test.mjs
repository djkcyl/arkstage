import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeClient, normalizeActivities, probe, update } from "./sync-resources.mjs";
import { parseIndex, parseTaxonomy } from "../gen-index/resource-parsers.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");
const response = (value, headers) => new Response(JSON.stringify(value), { headers });
const temp = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arkstage-resource-test-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
const main = ["主线一", "主线二", "主线三", "主线四", "主线五"];
const table = (title, books) => `<table class="wikitable"><tr><th>${title}</th></tr>${books.map(book => `<tr><th>${book}</th><td><a href='/w/example'>剧情</a></td></tr>`).join("")}</table>`;
const html = table("主线剧情一览", main) + table("活动剧情一览", ["旧书", "新书", "联动新书"]);
const raw = "==新的故事线==\n{{/乐章\n|名称=旧书\n}}\n{{/乐章\n|名称=新书\n}}";

test("discovers new taxonomy headings, main chapters and collabs without curated additions", () => {
  const index = parseIndex(html);
  const result = parseTaxonomy(raw, index, [{ short: "联动新书", collab: true }], [["为了明日", main], ["新的故事线", ["旧书"]]]);
  assert.deepEqual(result, [["为了明日", main], ["新的故事线", ["旧书", "新书"]], ["联动", ["联动新书"]]]);
  assert.throws(() => parseTaxonomy("bad", index, [], result), /Incomplete/);
});

test("conditional API requests reuse normalized bodies on 304 and reject server errors", async () => {
  const url = 'https://api.github.com/test'; let calls = 0;
  const client = makeClient(async (_url, options) => {
    calls++; assert.equal(options.headers['If-None-Match'], 'v1'); return new Response(null, { status: 304 });
  }, { [url]: { etag: 'v1', value: [1, 2] } });
  assert.deepEqual(await client.get(url), [1, 2]); assert.equal(calls, 1);
  await assert.rejects(makeClient(async () => new Response('error', { status: 503 })).get(url), /503/);
  assert.throws(() => normalizeActivities({ query: { results: {} } }), /Incomplete/);
});

test("no-change probes make only batched metadata calls, while image SHA changes invalidate them", async t => {
  const root = await temp(t), base = path.join(root, 'base'); await fs.mkdir(base);
  let imageSha = 'a'.repeat(40), requests = 0;
  const fetcher = async input => {
    requests++; const url = new URL(input);
    if (url.hostname === 'api.github.com') return response(Array.from({ length: 20 }, (_, i) => ({ name: `kv_test${i}.png`, sha: 'b'.repeat(40), download_url: `https://example.com/${i}` })));
    assert.equal(url.hostname, 'prts.wiki', 'probe downloaded image bytes');
    if (url.searchParams.get('action') === 'ask') return response({ query: { results: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, { fulltext: `活动${i}`, printouts: { '分类': [{ fulltext: '分类:支线故事' }], '名称缩短': [`活动${i}`], '标题图文件名': [`file${i}.png`] } }])) } });
    if (url.searchParams.get('prop') === 'revisions') return response({ query: { pages: ['剧情一览', '关卡一览/曲谱'].map(title => ({ title, revisions: [{ revid: 123 }] })) } });
    assert.equal(url.searchParams.get('prop'), 'imageinfo');
    return response({ query: { pages: url.searchParams.get('titles').split('|').map(title => ({ title, imageinfo: [{ sha1: imageSha, url: `https://example.com/${encodeURIComponent(title)}`, width: 100, height: 100 }] })) } });
  };
  const first = await probe({ base, work: path.join(root, 'work'), fetcher }); assert.equal(first.changed, true);
  await write(path.join(base, 'automation-state.json'), { fingerprint: first.fingerprint, requests: first.requests });
  requests = 0;
  const unchanged = await probe({ base, work: path.join(root, 'work'), fetcher });
  assert.equal(unchanged.changed, false); assert.ok(requests <= 7);
  imageSha = 'c'.repeat(40);
  assert.equal((await probe({ base, work: path.join(root, 'work'), fetcher })).changed, true);
});

test("incremental updates preserve old art and overrides, discover new covers, and download only changed bytes", async t => {
  const root = await temp(t), base = path.join(root, 'base'), work = path.join(root, 'work');
  const oldBytes = Buffer.from('RIFF old WEBP'), oldPath = `covers/${digest(oldBytes).slice(0, 20)}.webp`;
  await fs.mkdir(path.join(base, 'covers'), { recursive: true }); await fs.writeFile(path.join(base, oldPath), oldBytes);
  const previous = { schemaVersion: 1, version: 'old', storylines: [["为了明日", main], ["新的故事线", ["旧书"]]], covers: { '旧书': { path: oldPath, width: 100, height: 200 } }, banners: {}, scenarioLinks: { custom: 'preserved' } };
  await write(path.join(base, 'metadata.json'), previous);
  const bodies = { 'https://example.com/kv': Buffer.from('png KV'), 'https://example.com/old': Buffer.from('png old banner'), 'https://example.com/new': Buffer.from('png new banner') };
  const kvSha = () => sha1(Buffer.concat([Buffer.from(`blob ${bodies['https://example.com/kv'].length}\0`), bodies['https://example.com/kv']]));
  const plan = { fingerprint: 'test', recipeHash: 'recipe', requests: {}, maps: { kv: { native: '旧书' }, covers: {}, banners: { '旧书': 'old.png' } }, inputs: {
    kvs: { native: { sha: kvSha(), url: 'https://example.com/kv' } },
    activities: [{ short: '新书', title: '新书', file: 'new.png', collab: false }],
    images: { 'old.png': { sha1: sha1(bodies['https://example.com/old']), url: 'https://example.com/old' }, 'new.png': { sha1: sha1(bodies['https://example.com/new']), url: 'https://example.com/new' } },
  } };
  await write(path.join(work, 'probe.json'), plan);
  let downloaded = 0, conversions = 0;
  const fetcher = async url => { if (url.startsWith('https://prts.wiki/w/')) return new Response(url.endsWith('?action=raw') ? raw : html); downloaded++; return new Response(bodies[url]); };
  const convert = async (bytes, spec) => { conversions++; return { bytes: Buffer.concat([Buffer.from('RIFF WEBP ' + spec.kind), bytes]), width: 100, height: 200 }; };
  const out = path.join(root, 'out');
  const payload = await update({ base, out, work, fetcher, convert });
  assert.ok(payload.covers['新书'] && payload.banners['新书']); assert.equal(downloaded, 3);
  assert.deepEqual(payload.scenarioLinks, previous.scenarioLinks);
  downloaded = conversions = 0;
  const same = await update({ base: out, out: path.join(root, 'out2'), work, fetcher, convert });
  assert.equal(downloaded, 0); assert.equal(conversions, 0); assert.equal(payload.version, same.version);
  bodies['https://example.com/kv'] = Buffer.from('png changed KV'); plan.inputs.kvs.native.sha = kvSha();
  await write(path.join(work, 'probe.json'), plan);
  await update({ base: out, out: path.join(root, 'out3'), work, fetcher, convert });
  assert.equal(downloaded, 1); assert.equal(conversions, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(base, 'metadata.json'))), previous, 'source branch was mutated');
});
