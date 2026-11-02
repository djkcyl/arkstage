import assert from "node:assert/strict";
import test from "node:test";

test("logs and last playback checkpoint survive a renderer reload", async () => {
  const stored = new Map();
  globalThis.localStorage = {getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)};
  const first = await import("../../../build/test/debugLog.js?first-session");
  first.pushLog("error", "GPU initialization failed", {message:"driver lost",stack:"iframe stack"});
  await first.playbackCheckpoint("SR-ST-1 月落/NBT", "renderer-mount");
  const reopened = await import("../../../build/test/debugLog.js?after-process-death");
  assert.ok(reopened.getEntries().some(e=>e.msg.includes("iframe stack")));
  assert.equal(reopened.getInterruptedPlayback().stage,"renderer-mount");
  assert.equal(reopened.getInterruptedPlayback().title,"SR-ST-1 月落/NBT");
  await reopened.playbackCheckpoint("SR-ST-1 月落/NBT", "disposed");
  const clean = await import("../../../build/test/debugLog.js?after-clean-exit");
  assert.equal(clean.getInterruptedPlayback(),null);
  clean.clearLog();
  assert.equal(JSON.parse(stored.get("prts-diagnostic-journal-v1")).length,0);
});

test("oversized logs stay bounded and preserve the newest diagnostic", async () => {
  const stored = new Map();
  globalThis.localStorage = {getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)};
  const journal = await import("../../../build/test/debugLog.js?bounded");
  for(let n=0;n<60;n++)journal.pushLog("error",`${n}:`+"x".repeat(16000));
  assert.ok(stored.get("prts-diagnostic-journal-v1").length<=128*1024);
  assert.ok(journal.getEntries().at(-1).msg.startsWith("59:"));
});
