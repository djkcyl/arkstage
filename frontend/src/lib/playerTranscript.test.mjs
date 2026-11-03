import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscript } from "../../../build/test/playerTranscript.js";
import { getLogFontSize, setLogFontSize, LOG_FONT_DEFAULT } from "../../../build/test/uiSettings.js";

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};

test("dialogue keeps speakers separate from text and preserves engine line positions", () => {
  const script = '[HEADER]\n// comment\n[name="吉阿达"]（深呼吸）\n\n[name=\'裘里奥\']——抱歉！';
  assert.deepEqual(buildTranscript(script), [
    { line: 2, speaker: "吉阿达", text: "（深呼吸）" },
    { line: 4, speaker: "裘里奥", text: "——抱歉！" },
  ]);
  assert.deepEqual(buildTranscript(script, 2), buildTranscript(script).slice(0, 1));
  assert.deepEqual(buildTranscript(script, null), []);
});

test("narration and formatted line breaks remain readable without leaking stage commands", () => {
  const script = '[Background(image="test")]\n[name=""]<b>旁白</b>\\n下一行<br/>末行\n普通叙述\n[name="角色"]<color=#fff>对话</color>\n[name="角色"]';
  assert.deepEqual(buildTranscript(script), [
    { line: 1, speaker: "", text: "旁白\n下一行\n末行" },
    { line: 2, speaker: "", text: "普通叙述" },
    { line: 3, speaker: "角色", text: "对话" },
  ]);
});

test("LOG font size survives a new read, clamps changes and recovers invalid saved values", () => {
  storage.clear();
  assert.equal(getLogFontSize(), LOG_FONT_DEFAULT);
  setLogFontSize(25);
  assert.equal(getLogFontSize(), 25);
  setLogFontSize(200);
  assert.equal(getLogFontSize(), 32);
  setLogFontSize(0);
  assert.equal(getLogFontSize(), 12);
  for (const value of ["bad", "Infinity", "-8", "0", "100"]) {
    storage.set("prts-log-font-size", value);
    assert.equal(getLogFontSize(), LOG_FONT_DEFAULT);
  }
});
