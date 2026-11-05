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

for (const prefix of ["LogNative", "z9_"]) test(`reuses upstream LOG component, parser and theme across renamed bindings (${prefix})`, async () => {
  const extra = `
    const ${prefix}List = {__name:'LogAllList',render(row){return {'data-active-line':row.active,class:'log-row'};}};
    const ${prefix}Panel = {__name:\`LogAllPanel\`,props:{show:{},document:{}},setup(props){return ()=>${prefix}VNode(${prefix}List,{document:{}})}};
    const ${prefix}Config = {};
    function ${prefix}Theme(){return {theme:'native-theme',themeOverrides:{common:{textColor1:'#abc'}}};}
    function ${prefix}VNode(component,props,slots){return {component,props,slots};}
    const ${prefix}Widget = {setup(){const {theme,themeOverrides}=${prefix}Theme();return ()=>${prefix}VNode(${prefix}Config,{theme,'theme-overrides':themeOverrides})}};
    function ${prefix}Document(flow){return {blocks:flow.lines,conditions:{evaluatePartial:()=>true},decisions:[],degraded:false};}
    function ${prefix}Log(lines,variables){return ${prefix}Document({lines,variables});}
    function ${prefix}App(options){return {mount(host){const view=Object.assign(options.data(), options.setup());host.view=view;host.render=()=>options.render.call(view);return view;},unmount(){globalThis.nativeLogUnmounted=true;}};}
    false ? ${prefix}App(${prefix}Widget).mount({}) : null;
  `;
  const source = fixture(prefix).replace(`${prefix}Player().mount({});`, '') + extra;
  const output = buildEngineModule(source, ENTRY, new Map([[CONTEXT, contextSource]]), url => url === CONTEXT
    ? `data:text/javascript;base64,${Buffer.from(contextSource).toString("base64")}` : url);
  const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const api=module.arkstageEngine;
  assert.equal(api.nativeLog,true);
  assert.equal(api.nativeLogSeek,true);
  assert.match(output, /'data-arkstage-log-index':row.entry.lineIndex/);
  const entry={lineIndex:4,speaker:'角色',source:'dialogue',spans:[{text:'原生对白'}]};
  const context={script:[{lineNumber:4,kind:'lines',audience:0,entries:[entry]},{lineNumber:8,kind:'lines',audience:0,entries:[]},
    {lineNumber:8,kind:'command',command:'endtip',args:{block:true}}],audioVariables:{nickname:'博士'}};
  const document=api.buildLog(context);
  assert.deepEqual(document.blocks,context.script);
  const handlers=new Map();const row={getAttribute:()=>"1"};
  const host={addEventListener:(type,fn)=>handlers.set(type,fn),removeEventListener:type=>handlers.delete(type),contains:value=>value===row};
  let closed=0, completeBuilds=0;const sought=[];
  const select=type=>handlers.get(type)({type,key:'Enter',target:{closest:()=>row},preventDefault(){},stopPropagation(){}});
  const view=api.mountLog(host,()=>{completeBuilds++;return document;},context,{lineIndex:4,selections:[],readLines:[4]},28,()=>closed++,index=>sought.push(index));
  select('click');assert.deepEqual(sought,[0]);
  let tree=host.render();
  assert.equal(tree.props.theme,'native-theme');
  assert.equal(tree.props.themeOverrides.common.fontSize,'28px');
  let panel=tree.slots.default()[0];
  assert.equal(panel.component.__name,'LogAllPanel');
  assert.equal(panel.props.arkstageReadLog,true);
  assert.equal(panel.props.document.blocks.length,1);
  assert.equal(panel.props.document.blocks[0].lineNumber,1);
  assert.equal(panel.props.activeLineIndex,1);
  assert.equal(panel.props.embedded,true);
  assert.equal(completeBuilds,0,'opening read LOG must not analyze future branches');
  view.update({lineIndex:8,selections:[{decisionId:5,optionIndex:1}],readLines:[4,8]});
  panel=host.render().slots.default()[0];
  assert.equal(panel.props.activeLineIndex,2);
  view.update({lineIndex:4,selections:[],readLines:[4,8],readCursor:1});
  assert.equal(host.render().slots.default()[0].props.activeLineIndex,1,'rewind must highlight the chosen historical row');
  view.update({lineIndex:8,selections:[{decisionId:5,optionIndex:1}],readLines:[4,8]});
  assert.equal(panel.props.document.blocks.at(-1).kind,'lines', 'implicit endtip must not overwrite the final displayed line');
  assert.deepEqual(panel.props.selections,[]);
  panel.props.onArkstageLogModeChange();
  panel=host.render().slots.default()[0];
  assert.equal(panel.props.arkstageReadLog,false);
  select('click');assert.deepEqual(sought,[0],'all text cannot jump to unvisited content');
  assert.equal(panel.props.document,document);
  assert.equal(completeBuilds,1);
  assert.equal(panel.props.activeLineIndex,8);
  assert.deepEqual(panel.props.selections,[{decisionId:5,optionIndex:1}]);
  panel.props.onArkstageLogModeChange();
  assert.equal(host.render().slots.default()[0].props.arkstageReadLog,true);
  select('keydown');assert.deepEqual(sought,[0,0]);
  panel.props['onUpdate:show'](false);assert.equal(closed,1);
  view.dispose();assert.equal(globalThis.nativeLogUnmounted,true);
  assert.equal(handlers.size,0);
});

test("unsupported modules fail explicitly instead of presenting a frozen player", () => {
  assert.throws(() => buildEngineModule("export const unknown=1;", ENTRY, new Map(), (url) => url), /模块接口不兼容/);
});

for (const declaration of ["class NativeAudio", "const NativeAudio = class"]) test(`installs music continuity on ${declaration}`, async () => {
  const source = fixture("Music") + `${declaration} {
    playMusic(){} stopMusic(){} createPlayback(){} getSound(){} destroy(){}
  }; export {NativeAudio};`;
  const output = buildEngineModule(source, ENTRY, new Map([[CONTEXT, contextSource]]), url => url === CONTEXT
    ? `data:text/javascript;base64,${Buffer.from(contextSource).toString("base64")}` : url);
  const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  assert.equal(module.arkstageEngine.musicContinuity, true);
  assert.match(module.NativeAudio.prototype.createPlayback.toString(), /identity.split/);
});

test("native sticker shows/appends report source positions, excluding hidden/invalid/hidelog commands", async () => {
  const extra=`export class StickerRuntime {
    constructor(){this.displayedLineIndex=null;this.renderer={setSticker:input=>input};}
    async executeBuiltinCommand(e){switch(e.command){case 'sticker':{const e='shadowed-id';if(!arguments[0].args.text)return 'hidden';if(arguments[0].args.invalid)return 'invalid';return await this.renderer.setSticker({id:e,text:arguments[0].args.text});}}}
  }`;
  const output=buildEngineModule(fixture('Sticker')+extra,ENTRY,new Map([[CONTEXT,contextSource]]),url=>url===CONTEXT
    ? `data:text/javascript;base64,${Buffer.from(contextSource).toString("base64")}` : url);
  const {StickerRuntime}=await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const player=new StickerRuntime();
  assert.deepEqual(await player.executeBuiltinCommand({command:'sticker',lineNumber:10,args:{text:'信件第一段'}}),{id:'shadowed-id',text:'信件第一段'});
  assert.equal(player.displayedLineIndex,10);
  await player.executeBuiltinCommand({command:'sticker',lineNumber:11,args:{text:'追加内容',multi:true}});
  assert.equal(player.displayedLineIndex,11);
  for(const args of [{},{text:'无效',invalid:true},{text:'不记录',hidelog:true}]) {
    await player.executeBuiltinCommand({command:'sticker',lineNumber:12,args});
    assert.equal(player.displayedLineIndex,11);
  }
});

test("renderer uses WebGL with bounded resolution after viewport changes", async () => {
  const extra = `
    function displayResolution(host){return host.dpr;}
    export class Renderer {
      async mount(host){const app={async init(options){globalThis.renderOptions=options}}; await app.init({width:1280,height:720,preference:'webgpu',antialias:true,resolution:displayResolution(host)});}
      resize(host){return displayResolution(host);}
    }
  `;
  const output = buildEngineModule(fixture("Graphics") + extra, ENTRY, new Map([[CONTEXT, contextSource]]), (url) => url === CONTEXT
    ? `data:text/javascript;base64,${Buffer.from(contextSource).toString("base64")}` : url);
  const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const renderer = new module.Renderer();
  await renderer.mount({dpr:4});
  assert.equal(globalThis.renderOptions.preference, "webgl");
  assert.equal(globalThis.renderOptions.antialias, false);
  assert.equal(globalThis.renderOptions.resolution, 1.5);
  assert.equal(renderer.resize({dpr:3}), 1.5);
  assert.equal(renderer.resize({dpr:0.75}), 0.75);
});

test("preload defers audio decoding and bounds image batches without breaking lazy audio", async () => {
  let source = fixture("Memory").replace("const Assets = {load:async()=>{}}", "const Assets = {load:async(input)=>{globalThis.assetLoads.push(input);return {}}}");
  source = source.replace("return [...urls];", "return [...urls, 'track.mp3', 'effect.ogg', 'a.png', 'b.png', 'c.png', 'd.png'];");
  source += "export async function lazyAudio(){await Assets.load('track.mp3')}";
  const output = buildEngineModule(source, ENTRY, new Map([[CONTEXT, contextSource]]), (url) => url === CONTEXT
    ? `data:text/javascript;base64,${Buffer.from(contextSource).toString("base64")}` : url);
  globalThis.assetLoads = [];
  const oldFontFace = globalThis.FontFace;
  globalThis.FontFace = class {};
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    await module.arkstageEngine.preload(await module.arkstageEngine.loadContext("test"));
    assert.ok(globalThis.assetLoads.length >= 3);
    assert.ok(globalThis.assetLoads.every(batch=>Array.isArray(batch)&&batch.length<=2));
    assert.ok(globalThis.assetLoads.flat().every(url=>!url.endsWith('.mp3')&&!url.endsWith('.ogg')));
    await module.lazyAudio();
    assert.equal(globalThis.assetLoads.at(-1), 'track.mp3');
  } finally { globalThis.FontFace = oldFontFace; delete globalThis.assetLoads; }
});

test("live upstream module can be adapted when fixtures are provided", { skip: !process.env.PRTS_MODULE_FIXTURE || !process.env.PRTS_CONTEXT_FIXTURE }, () => {
  const source = readFileSync(process.env.PRTS_MODULE_FIXTURE, "utf8");
  const dependency = moduleDependencies(source, ENTRY).find((url) => /\/context\./.test(url));
  assert.ok(dependency);
  const output = buildEngineModule(source, ENTRY, new Map([[dependency, readFileSync(process.env.PRTS_CONTEXT_FIXTURE, "utf8")]]), (url) => url);
  assert.doesNotThrow(() => parse(output, {ecmaVersion:"latest",sourceType:"module"}));
  assert.ok(output.includes("export const arkstageEngine"));
  assert.match(output, /nativeLog:\s*true/);
  assert.match(output, /nativeLogSeek:\s*true/);
  assert.match(output, /\[`data-active-line`,'data-arkstage-log-index'\]/);
  assert.match(output, /musicContinuity:\s*true/);
});
