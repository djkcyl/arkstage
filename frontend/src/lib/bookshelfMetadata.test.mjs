import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FALLBACK_CATEGORY,
  RESOURCE_ROOTS,
  fetchRemoteBookshelfMetadata,
  parseBookshelfMetadata,
} from "../../../build/test/bookshelfMetadata.js";

const valid = {
  schemaVersion: 1,
  version: "0123456789abcdef0123",
  storylines: [["特殊", ["旧章节"]]],
  covers: {
    丛林症结: { path: "covers/0123456789abcdef0123.webp", width: 420, height: 303 },
  },
  banners: {},
  scenarioLinks: {},
};

test("旧缓存中的特殊分类会无损迁移", () => {
  const parsed = parseBookshelfMetadata(valid);
  assert.equal(parsed?.fallbackCategory, DEFAULT_FALLBACK_CATEGORY);
  assert.equal(parsed?.storylines[0][0], DEFAULT_FALLBACK_CATEGORY);
  assert.deepEqual(parsed?.storylines[0][1], ["旧章节"]);
});

test("拒绝可逃逸资源分支的图片路径", () => {
  const invalid = structuredClone(valid);
  invalid.covers.丛林症结.path = "../private.webp";
  assert.equal(parseBookshelfMetadata(invalid), null);
});

test("jsDelivr 失败后回退 GitHub Raw，且两次都禁用浏览器缓存", async () => {
  const calls = [];
  const result = await fetchRemoteBookshelfMetadata(async (url, init) => {
    calls.push([url, init]);
    if (url.startsWith(RESOURCE_ROOTS.jsdelivr)) return new Response("down", { status: 503 });
    return Response.json(valid);
  });
  assert.equal(result.source, "github");
  assert.deepEqual(calls.map(([url]) => url), [
    `${RESOURCE_ROOTS.jsdelivr}/metadata.json`,
    `${RESOURCE_ROOTS.github}/metadata.json`,
  ]);
  assert.ok(calls.every(([, init]) => init.cache === "no-store"));
});

test("双源都失败时明确报错", async () => {
  await assert.rejects(
    fetchRemoteBookshelfMetadata(async () => new Response("down", { status: 503 })),
    /jsdelivr: HTTP 503.*github: HTTP 503/
  );
});

test("首选源超时后仍会进入 GitHub 回退", async () => {
  const result = await fetchRemoteBookshelfMetadata((url, init) => {
    if (url.startsWith(RESOURCE_ROOTS.github)) return Promise.resolve(Response.json(valid));
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  }, 5);
  assert.equal(result.source, "github");
});
