import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import { installMusicContinuity } from "../../../build/test/musicContinuity.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
globalThis.requestAnimationFrame = callback => setTimeout(callback, 1);

class NativeAudio {
  destroyed = false; musicRequestId = 0; musicAudio = null; soundCache = new Map(); soundChannels = new Map();
  constructor(context) { this.assets = context.assets; }
  async getSound(url) { if (!this.soundCache.has(url)) this.soundCache.set(url, await this.assets.load(url)); return this.soundCache.get(url); }
  async createPlayback(url, identity) { const sound = await this.getSound(url); return sound ? { sound, identity, instance: null } : null; }
  async playMusic(input) {
    const request = ++this.musicRequestId, identity = `${input.intro ?? ''}\n${input.key}`;
    if (input.delayMs) await delay(input.delayMs);
    const next = await this.createPlayback(input.intro || input.key, identity);
    if (!next || this.destroyed || request !== this.musicRequestId) return;
    const previous = this.musicAudio; this.musicAudio = next;
    next.instance = next.sound.play({ loop: !input.intro, complete: input.intro ? async () => {
      if (this.destroyed || this.musicAudio !== next) return;
      const loop = await this.createPlayback(input.key, identity);
      if (!loop || this.destroyed || request !== this.musicRequestId) return;
      this.musicAudio = loop; loop.instance = loop.sound.play({ loop: true });
    } : undefined });
    previous?.instance?.stop();
  }
  async stopMusic() { this.musicRequestId++; this.musicAudio?.instance?.stop(); this.musicAudio = null; }
  destroy() { this.destroyed = true; this.musicAudio?.instance?.stop(); this.musicAudio = null; }
}

function fixture() {
  const sounds = new Map(), holds = new Map(), calls = [], released = [];
  function sound(url) {
    if (sounds.has(url)) return sounds.get(url);
    const value = { isPlaying: false, instances: [], plays: [], play(options) {
      value.isPlaying = true; value.plays.push(options);
      const instance = { volume: options.volume ?? 1, stop() { value.isPlaying = false; value.instances = []; } };
      value.instances.push(instance); return instance;
    }, finish() { value.isPlaying = false; value.instances = []; value.plays.at(-1)?.complete?.(); } };
    sounds.set(url, value); return value;
  }
  const assets = { get: url => sounds.get(url), load: async url => {
    calls.push(url); if (holds.has(url)) await holds.get(url).promise; return sound(url);
  } };
  let Base = NativeAudio;
  if (process.env.PRTS_AUDIO_FIXTURE) {
    let source = fs.readFileSync(process.env.PRTS_AUDIO_FIXTURE, 'utf8');
    const ast = ts.createSourceFile('audio.ts', source, ts.ScriptTarget.Latest, true);
    for (const statement of [...ast.statements].reverse()) if (ts.isImportDeclaration(statement)) source = source.slice(0, statement.getFullStart()) + source.slice(statement.end);
    const output = ts.transpileModule(source.replace('export class HtmlStoryAudio', 'class HtmlStoryAudio'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
    Base = new Function('Assets', 'resolveStoryAudioByKey', `${output}\nreturn HtmlStoryAudio;`)(assets, key => key);
  }
  class Audio extends Base {}
  installMusicContinuity(Audio.prototype, async url => { released.push(url); sounds.delete(url); });
  return { audio: new Audio({ assets, audioVariables: {} }), holds, calls, released, sound };
}
const music = (key, intro) => ({ key, intro, volume: 1, delayMs: 0, crossfadeMs: 0 });

test("keep old BGM playing until both new intro and loop are decoded", async () => {
  const f = fixture(); await f.audio.playMusic(music('old'));
  const loop = deferred(); f.holds.set('loop', loop);
  const next = f.audio.playMusic(music('loop', 'intro')); await tick(); await tick();
  assert.equal(f.sound('old').isPlaying, true);
  assert.equal(f.sound('intro').plays.length, 0, 'intro started before the loop was ready');
  loop.resolve(); await next;
  assert.equal(f.sound('old').isPlaying, false);
  assert.equal(f.sound('intro').isPlaying, true);
  f.sound('intro').finish(); await tick(); await tick();
  assert.equal(f.sound('loop').isPlaying, true);
  assert.equal(f.calls.filter(url => url === 'loop').length, 1, 'intro completion reloaded the loop');
  f.audio.destroy();
});

test("stop while a BGM pair is pending cancels the queued loop without restarting music", async () => {
  const f = fixture(), intro = deferred(); f.holds.set('intro', intro);
  const next = f.audio.playMusic(music('loop', 'intro')); await tick();
  await f.audio.stopMusic(0); intro.resolve(); await next; await tick();
  assert.equal(f.audio.musicAudio, null);
  assert.equal(f.calls.includes('loop'), false, 'obsolete loop was decoded after stop');
  assert.equal(f.sound('intro').isPlaying, false);
  f.audio.destroy();
});

test("destroying during preparation never starts late audio", async () => {
  const f = fixture(), intro = deferred(); f.holds.set('intro', intro);
  const next = f.audio.playMusic(music('loop', 'intro')); await tick();
  f.audio.destroy(); intro.resolve(); await next; await tick();
  assert.equal(f.audio.musicAudio, null);
  assert.equal(f.calls.includes('loop'), false);
});

test("retired music buffers are released while the current intro/loop pair remains ready", async () => {
  const f = fixture(); await f.audio.playMusic(music('old'));
  await f.audio.playMusic(music('loop', 'intro')); await delay(320);
  assert.ok(f.released.includes('old'));
  assert.ok(!f.released.includes('intro') && !f.released.includes('loop'));
  assert.ok(f.audio.soundCache.size <= 2);
  f.audio.destroy();
});

test("concurrent requests for one track share a single load", async () => {
  const f = fixture(), load = deferred(); f.holds.set('shared', load);
  const a = f.audio.getSound('shared'), b = f.audio.getSound('shared');
  await tick(); assert.equal(f.calls.length, 1); load.resolve();
  assert.equal(await a, await b); f.audio.destroy();
});
