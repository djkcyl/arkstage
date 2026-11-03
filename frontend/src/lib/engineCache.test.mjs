import assert from "node:assert/strict";
import test from "node:test";
import { cachedEngine } from "../../../build/test/engineCache.js";

const descriptor = { entry_url: "https://static.prts.wiki/widgets/production/StoryPlayer.ABC123.js", stylesheet_urls: [], polyfill_urls: [] };
function fixture() {
  const files = new Map(); let builds = 0, writes = 0;
  return {
    files, get builds() { return builds; }, get writes() { return writes; },
    storage: { read: async key => files.get(key) ?? null, write: async (key, data) => { writes++; files.set(key, data); } },
    build: async () => { builds++; return { source: "export const valid = true", resources: [descriptor.entry_url], revision: "a".repeat(64) }; },
  };
}
test("an unchanged hashed release survives process reload without rebuilding or rewriting", async () => {
  const f = fixture();
  assert.equal((await cachedEngine(descriptor, f.storage, f.build)).reused, false);
  assert.equal((await cachedEngine(descriptor, f.storage, f.build)).reused, true);
  assert.equal(f.builds, 1); assert.equal(f.writes, 1);
});
test("upstream releases, adapter routing changes and corrupt source trigger rebuilding", async () => {
  const f = fixture(); await cachedEngine(descriptor, f.storage, f.build);
  const [key, raw] = [...f.files][0]; const record = JSON.parse(raw);
  record.engine.source = "corrupted"; f.files.set(key, JSON.stringify(record));
  assert.equal((await cachedEngine(descriptor, f.storage, f.build)).reused, false);
  await cachedEngine({ ...descriptor, entry_url: descriptor.entry_url.replace('ABC123', 'NEW456') }, f.storage, f.build);
  await cachedEngine(descriptor, f.storage, f.build, 'other-platform');
  assert.equal(f.builds, 4);
});
test("unversioned entries are checked again and failed builds never poison the cache", async () => {
  const f = fixture(); const mutable = { ...descriptor, entry_url: descriptor.entry_url.replace('.ABC123', '') };
  await cachedEngine(mutable, f.storage, f.build); await cachedEngine(mutable, f.storage, f.build);
  assert.equal(f.builds, 2); assert.equal(f.writes, 0);
  await assert.rejects(cachedEngine(descriptor, f.storage, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(f.writes, 0);
});
