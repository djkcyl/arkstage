import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { installEngineCompatibility } from "../../../build/test/engineCompatibility.js";

test("current toolbox audio fades work when upstream omits Math.clamp", () => {
  const parentClamp = Math.clamp;
  const realm = vm.createContext({});
  vm.runInContext(`
    const intervals = new Map(); let intervalId = 0;
    function setInterval(callback, delay, ...args) {
      intervals.set(++intervalId, () => callback(...args)); return intervalId;
    }
    function clearInterval(id) { intervals.delete(id); }
    class HTMLElement {
      constructor() { this.attributes = new Map(); }
      getAttribute(key) { return this.attributes.get(key) ?? null; }
      setAttribute(key, value) { this.attributes.set(key, String(value)); }
      removeAttribute(key) { this.attributes.delete(key); }
    }
    class HTMLAudioElement extends HTMLElement {
      constructor() { super(); this.src = ""; this.volume = 1; }
    }
  `, realm);
  // Reproduce the upstream change using the bundled toolbox: audio.fade still
  // calls clamp, but the global assignment was removed in the live dependency.
  const toolbox = readFileSync(process.env.PRTS_TOOLBOX_FIXTURE || new URL("../../public/vendor/krliov.toolbox.js", import.meta.url), "utf8")
    .replace(/^Math\.clamp\s*=.*$/m, "");
  vm.runInContext(toolbox, realm);
  assert.throws(() => vm.runInContext("new HTMLAudioElement().fade(1, 0.4)", realm), /Math.clamp/);
  installEngineCompatibility(vm.runInContext("globalThis", realm));
  assert.doesNotThrow(() => vm.runInContext(`
    const audio = new HTMLAudioElement(); audio.fade(1, 0.4);
    for (let tick = 0; tick < 100; tick++) for (const run of intervals.values()) run();
  `, realm));
  assert.equal(vm.runInContext("audio.volume", realm), 0.4);
  assert.equal(vm.runInContext("intervals.size", realm), 0);
  assert.deepEqual(Array.from(vm.runInContext("[-1, 0, 0.5, 1, 2].map(v => Math.clamp(v, 0, 1))", realm)), [0, 0, 0.5, 1, 1]);
  assert.equal(vm.runInContext("Number.isNaN(Math.clamp(NaN, 0, 1))", realm), true);
  assert.equal(Math.clamp, parentClamp, "the parent realm must remain untouched");
});

test("offline toolbox implementations are preserved and each iframe is independent", () => {
  const first = vm.runInNewContext("globalThis");
  const second = vm.runInNewContext("globalThis");
  const original = (v) => v;
  first.Math.clamp = original;
  installEngineCompatibility(first);
  installEngineCompatibility(second);
  assert.equal(first.Math.clamp, original);
  assert.equal(second.Math.clamp(2, 0, 1), 1);
  const installed = second.Math.clamp;
  installEngineCompatibility(second);
  assert.equal(second.Math.clamp, installed);
});
