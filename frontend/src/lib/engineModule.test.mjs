import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "acorn";
import { buildEngineModule, moduleDependencies } from "../../../build/test/engineModule.js";

const ENTRY = "https://static.prts.wiki/widgets/production/StoryPlayer.changed-hash.js";
const CONTEXT = new URL("./context.changed-hash.js", ENTRY).href;
const contextSource = `async function loader(script) { return {script,scriptText:script,linkMap:{},storyMetadata:{}}; } export {loader as renamed};`;
const fixture = (prefix) => `
  import {renamed as ${prefix}Context} from './context.changed-hash.js';
  const Assets = {load:async()=>{}}, audio = {disableAutoPause:false, volumeAll:1};
  audio.disableAutoPause = true;
  const image = new URL('assets/ui.png', import.meta.url).href;
  function ${prefix}Player() {
    let renderer = {mount:async()=>{globalThis.arkstageTestMounts++}};
    return {async mount(host){await renderer.mount(host)},start(){},advance(){},destroy(){},getState(){return 'idle'},};
  }
  function ${prefix}Build(context,lines){return lines, {faceAssets:[],urls:['https://torappu.prts.wiki/one.png']};}
  function ${prefix}Lines(context){return context.script;}
  function ${prefix}Assets(context,lines){const urls=new Set(${prefix}Build(context,lines).urls);urls.add(image);return [...urls];}
  function ${prefix}Fonts(lines){return [{file:'dialog.woff2'}];}
  function ${prefix}FontUrl(file){return 'https://static.prts.wiki/'+file;}
  function ${prefix}LoadFont(font){return new FontFace('Dialog', 'url('+${prefix}FontUrl(font.file)+')');}
  async function ${prefix}Preload(context){const lines=${prefix}Lines(context),urls=${prefix}Assets(context,lines),fonts=${prefix}Fonts(lines);await Promise.all(fonts.map(${prefix}LoadFont));await Assets.load(urls);}
  export function readVolume(){return audio.volumeAll;}
  globalThis.arkstageTestMounts=0;
  ${prefix}Player().mount({});
`;

test("module graph follows relative, exported and lazy imports", () => {
  assert.deepEqual(moduleDependencies(`import './a.js'; export {v} from './b.js'; const load=()=>import('./lazy.js');`, ENTRY), ["a.js", "b.js", "lazy.js"].map((file) => new URL(file, ENTRY).href));
});

for (const prefix of ["Readable", "x7_"]) test(`discovers native APIs after identifier/hash changes (${prefix})`, async () => {
  const output = buildEngineModule(fixture(prefix), ENTRY, new Map([[CONTEXT, contextSource]]), (url) => url === CONTEXT
    ? `data:text/javascript;base64,${Buffer.from(contextSource).toString("base64")}` : `https://cache.local/${new URL(url).pathname.slice(1)}`);
  parse(output, {ecmaVersion:"latest",sourceType:"module"});
  const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const api = module.arkstageEngine;
  assert.equal(globalThis.arkstageTestMounts, 0, "wiki lobby must not mount");
  const context = await api.loadContext("story");
  assert.equal(context.scriptText, "story");
  assert.deepEqual(api.manifest(context), ["https://torappu.prts.wiki/one.png", "https://cache.local/widgets/production/assets/ui.png", "https://static.prts.wiki/dialog.woff2"]);
  const player = api.createPlayer(context);
  await player.mount({});
  assert.equal(globalThis.arkstageTestMounts, 1);
  assert.equal(typeof player.getRenderer().mount, "function");
  api.setVolume(0.4);
  assert.equal(module.readVolume(), 0.4);
});

test("unsupported modules fail explicitly instead of presenting a frozen player", () => {
  assert.throws(() => buildEngineModule("export const unknown=1;", ENTRY, new Map(), (url) => url), /模块接口不兼容/);
});

test("live upstream module can be adapted when fixtures are provided", { skip: !process.env.PRTS_MODULE_FIXTURE || !process.env.PRTS_CONTEXT_FIXTURE }, () => {
  const source = readFileSync(process.env.PRTS_MODULE_FIXTURE, "utf8");
  const dependency = moduleDependencies(source, ENTRY).find((url) => /\/context\./.test(url));
  assert.ok(dependency);
  const output = buildEngineModule(source, ENTRY, new Map([[dependency, readFileSync(process.env.PRTS_CONTEXT_FIXTURE, "utf8")]]), (url) => url);
  assert.doesNotThrow(() => parse(output, {ecmaVersion:"latest",sourceType:"module"}));
  assert.ok(output.includes("export const arkstageEngine"));
});
