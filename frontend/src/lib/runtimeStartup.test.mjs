import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const VERSION = 'startup-test-adapter';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const drain = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
async function moduleFor(file, imports, globals = {}, extra = '') {
  const context=vm.createContext({console,URL,Response,TextEncoder,crypto,performance,setTimeout,clearTimeout,...globals});
  const source=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText;
  const module=new vm.SourceTextModule(source,{context});
  await module.link(name => {
    const values=imports[name]; if(!values)throw Error('Unmocked import '+name);
    return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
  });
  await module.evaluate();return module.namespace;
}
const bundle=()=>({engine_scripts:[],data_blocks_html:'<pre id="datas_txt">story</pre>',dom_html:'',revision:'engine-one',validation_version:VERSION,
  module_engine:{entry_url:'https://static.prts.wiki/widgets/production/StoryPlayer.ABC123.js',stylesheet_urls:[],polyfill_urls:[]}});
const runtime=()=>({story:{title:'test/NBT',script:'[name="角色"]已读内容'},bundle:bundle(),revision:'snapshot-one',validationVersion:VERSION});
async function fixture(cached=runtime()) {
  const db=new Map();if(cached)db.set('story-runtime-v6_test_NBT',JSON.stringify(cached));
  const storyCheck=deferred(),bundleCheck=deferred(),versionCheck=deferred(),pageCheck=deferred(),calls={story:0,bundle:0,version:0,pages:0,boots:0,writes:0,bootError:false},progress=[];
  const api=await moduleFor('./predownload.ts',{
    '@tauri-apps/api/core':{invoke:async(cmd,args)=>{
      if(cmd==='load_from_cache')return db.get(args.key)||null;
      if(cmd==='save_to_cache'){calls.writes++;db.set(args.key,args.data);return;}
      if(cmd==='fetch_engine_version'){calls.version++;return versionCheck.promise;}
      if(cmd==='fetch_page_revisions'){calls.pages++;return pageCheck.promise;}
      if(cmd==='fetch_story_runtime'){calls.story++;return storyCheck.promise;}
      if(cmd==='fetch_widget_bundle'){calls.bundle++;return bundleCheck.promise;}
      throw Error('Unexpected IPC '+cmd);
    }},
    '@tauri-apps/api/event':{listen:async()=>()=>{}},
    './engineBoot':{bootEngineInFrame:async()=>{calls.boots++;if(calls.bootError)throw Error('invalid candidate');return {health:{globals:['a','b','c','d'],metadataUrls:[]},manifest:['https://static.prts.wiki/widget.png']};},prewarmEngineDeps:async()=>{},refreshEngineDeps:async()=>{}},
    './keepalive':{setManifestProgress:()=>{}},'./debugLog':{pushLog:()=>{}},'./modernEngine':{modernEngineRevision:async()=>''},
    './engineCache':{ENGINE_ADAPTER_VERSION:VERSION},'./loadingProgress':{reportLoading:p=>progress.push(p)},
  },{document:{createElement:()=>({style:{},remove(){}}),body:{appendChild(){}}},DOMParser:class{parseFromString(){return {getElementById:()=>({textContent:'story'})};}}});
  return {api,db,storyCheck,bundleCheck,versionCheck,pageCheck,calls,progress};
}

test('verified playback returns before a stalled network check and concurrent opens share that check',{timeout:2000},async()=>{
  const f=await fixture();const one=f.api.loadStoryRuntime('test/NBT'),two=f.api.loadStoryRuntime('test/NBT');assert.equal(one,two);
  const local=await one;assert.equal(local.source,'verified-cache');assert.equal(local.story.script,runtime().story.script);assert.equal(f.calls.story,1);assert.equal(f.calls.boots,0);
  f.storyCheck.resolve(runtime());await drain();assert.equal((await f.api.loadStoryRuntime('test/NBT')).source,'verified-cache');assert.equal(f.calls.boots,0);assert.equal(f.calls.writes,0);
});
test('background updates are validated before promotion and only the next entry sees them',async()=>{
  const f=await fixture();const active=await f.api.loadStoryRuntime('test/NBT');const fresh={...runtime(),story:{title:'test/NBT',script:'[name="角色"]更新内容'},revision:'snapshot-two'};
  f.storyCheck.resolve(fresh);await drain();const next=await f.api.loadStoryRuntime('test/NBT');assert.equal(next.revision,'snapshot-two');assert.equal(active.revision,'snapshot-one');assert.equal(f.calls.boots,1);
  assert.equal(JSON.parse(f.db.get('story-runtime-v6_test_NBT-previous')).revision,'snapshot-one');assert.equal(JSON.parse(f.db.get('story-runtime-v6_test_NBT')).validationVersion,VERSION);
});
test('failed background validation retains the known-good disk snapshot',async()=>{
  const f=await fixture();await f.api.loadStoryRuntime('test/NBT');f.calls.bootError=true;f.storyCheck.resolve({...runtime(),revision:'bad-update'});await drain();
  const retained=await f.api.loadStoryRuntime('test/NBT');assert.equal(retained.revision,'snapshot-one');assert.equal(retained.source,'cache');assert.match(retained.warning,/invalid candidate/);assert.equal(f.calls.writes,0);
});
test('a changed adapter still requires foreground validation before treating its cache as verified',async()=>{
  const f=await fixture({...runtime(),validationVersion:'old-adapter'});let finished=false;const pending=f.api.loadStoryRuntime('test/NBT').then(value=>{finished=true;return value;});await drain();assert.equal(finished,false);
  f.storyCheck.resolve(runtime());assert.equal((await pending).source,'live');assert.equal(f.calls.boots,1);
});
test('without a verified local snapshot, a cold load still waits for the candidate',async()=>{
  const f=await fixture(null);let finished=false;const pending=f.api.loadStoryRuntime('test/NBT').then(value=>{finished=true;return value;});await drain();assert.equal(finished,false);
  f.storyCheck.resolve(runtime());assert.equal((await pending).source,'live');assert.equal(f.calls.boots,1);
});
test('the validated shared engine also starts locally while its Wiki check is pending',{timeout:2000},async()=>{
  const f=await fixture(null);f.db.set('widget-bundle-v6',JSON.stringify(bundle()));const pending=f.api.loadBundle();assert.equal((await pending).revision,'engine-one');
  assert.equal(f.calls.version,1);assert.equal(f.calls.bundle,0);assert.equal(f.calls.boots,0);f.versionCheck.resolve(bundle().module_engine);await drain();assert.equal(f.calls.writes,0);assert.equal(f.calls.bundle,0);
});

test('unchanged page and hashed player versions need no full snapshot or hidden boot',async()=>{
  const f=await fixture({...runtime(),page_revision:'17'});
  assert.equal((await f.api.loadStoryRuntime('test/NBT')).source,'verified-cache');
  assert.equal(f.calls.story,0);assert.equal(f.calls.pages,1);assert.equal(f.calls.version,1);
  f.pageCheck.resolve({'test/NBT':'17'});f.versionCheck.resolve(bundle().module_engine);await drain();
  assert.equal((await f.api.loadStoryRuntime('test/NBT')).source,'verified-cache');
  assert.equal(f.calls.story,0);assert.equal(f.calls.boots,0);assert.equal(f.calls.writes,0);
});
test('independent engine publication refreshes a story even when its page revision is unchanged',async()=>{
  const f=await fixture({...runtime(),page_revision:'17'});await f.api.loadStoryRuntime('test/NBT');
  f.pageCheck.resolve({'test/NBT':'17'});f.versionCheck.resolve({...bundle().module_engine,entry_url:'https://static.prts.wiki/widgets/production/StoryPlayer.NEW.js'});await drain();
  assert.equal(f.calls.story,1);f.storyCheck.resolve({...runtime(),revision:'new-engine',page_revision:'17'});await drain();
  assert.equal((await f.api.loadStoryRuntime('test/NBT')).revision,'new-engine');assert.equal(f.calls.boots,1);
});
test('a failed lightweight check retains local playback without launching expensive fallback requests',async()=>{
  const f=await fixture({...runtime(),page_revision:'17'});await f.api.loadStoryRuntime('test/NBT');
  f.pageCheck.reject(Error('version timeout'));f.versionCheck.resolve(bundle().module_engine);await drain();
  assert.equal((await f.api.loadStoryRuntime('test/NBT')).revision,'snapshot-one');assert.equal(f.calls.story,0);assert.equal(f.calls.boots,0);
});
test('manual reload bypasses session caches and validates even an unchanged snapshot',async()=>{
  const f=await fixture({...runtime(),page_revision:'17'});await f.api.loadStoryRuntime('test/NBT');
  const reload=f.api.reloadStoryRuntime('test/NBT');await drain();assert.equal(f.calls.story,1);
  f.storyCheck.resolve({...runtime(),page_revision:'17'});assert.equal((await reload).source,'live');assert.equal(f.calls.boots,1);
  f.pageCheck.resolve({'test/NBT':'17'});f.versionCheck.resolve(bundle().module_engine);await drain();
  assert.equal((await f.api.loadStoryRuntime('test/NBT')).source,'live');
});

async function metadataFixture(){
  const refresh=deferred(),calls=[],progress=[];let body='{"version":1}';
  const engine=deferred();
  const api=await moduleFor('./modernEngine.ts',{
    './engineModule':{moduleDependencies:()=>[],buildEngineModule:()=>''},'./proxy':{PROXY_BASE:'https://cache.local',proxyUrl:u=>u},
    './debugLog':{captureIframe:()=>{},pushLog:()=>{},playbackCheckpoint:async()=>{}},'./playbackModes':{createPlaybackModes:()=>{}},'./playerInput':{bindSceneInput:()=>{}},
    '@tauri-apps/api/core':{invoke:async()=>null},'./engineCache':{cachedEngine:()=>engine.promise,sha256:async()=>''},'./loadingProgress':{reportLoading:p=>progress.push(p)},
    './playbackResume':{readPlaybackResume:()=>null,savePlaybackResume:()=>{},clearPlaybackResume:()=>{}},
    './playbackCompletion':{createPlaybackCompletion:()=>()=>{}},
    './mediaCache':{resetPlaybackAssetRequests:()=>{},ensurePlaybackAsset:async(url,force)=>{calls.push({url,force});if(force)await refresh.promise;}},'./playerTranscript':{createLogPosition:()=>{},createReadLogHistory:()=>{}},
  },{fetch:async()=>new Response(body,{headers:{'Content-Type':'application/json'}})},'\nexport { metadataResponse, prepareEngine };');
  return {api,refresh,calls,progress,engine,setBody:value=>{body=value;}};
}
test('a local metadata snapshot never waits behind an in-flight revalidation and remains immutable',async()=>{
  const f=await metadataFixture(),url='https://torappu.prts.wiki/assets/avg/character.json';let refreshed=false;
  const network=f.api.metadataResponse(url,false,null).then(r=>{refreshed=true;return r;});const local=await f.api.metadataResponse(url,true);assert.equal((await local.clone().json()).version,1);assert.equal(refreshed,false);
  f.setBody('{"version":2}');f.refresh.resolve();assert.equal((await(await network).json()).version,2);assert.equal((await(await f.api.metadataResponse(url,true)).json()).version,2);assert.equal((await local.json()).version,1);
  assert.equal(f.calls.filter(c=>c.force).length,1);assert.equal(f.progress.length,1);
});
test('invalid local metadata cannot poison the response cache',async()=>{
  const f=await metadataFixture(),url='https://torappu.prts.wiki/assets/avg/background.json';f.setBody('broken');await assert.rejects(f.api.metadataResponse(url,true));f.setBody('{"version":3}');assert.equal((await(await f.api.metadataResponse(url,true)).json()).version,3);
});
test('a failed network metadata check retains the readable local response',async()=>{
  const f=await metadataFixture(),url='https://torappu.prts.wiki/assets/avg/character.json';
  const local=await f.api.metadataResponse(url,true);const pending=f.api.metadataResponse(url,false,null);
  f.refresh.reject(new Error('offline'));await assert.rejects(pending,/offline/);
  assert.equal((await local.json()).version,1);assert.equal((await(await f.api.metadataResponse(url,true)).json()).version,1);
});
test('manual reload discards a superseded metadata request before it can replace the new local snapshot',async()=>{
  const f=await metadataFixture(),url='https://torappu.prts.wiki/assets/avg/character.json';
  const old=f.api.metadataResponse(url,false,null);
  f.api.reloadModernEngine();f.setBody('{"version":2}');
  assert.equal((await(await f.api.metadataResponse(url,true)).json()).version,2);
  f.setBody('{"version":1}');f.refresh.resolve();await old;
  assert.equal((await(await f.api.metadataResponse(url,true)).json()).version,2);
});
test('foreground engine downloads retain progress when joining a quiet background preparation',async()=>{
  const f=await metadataFixture(),descriptor=bundle().module_engine,observed=[];
  const quiet=f.api.prepareEngine(descriptor);const visible=f.api.prepareEngine(descriptor,p=>observed.push(p));
  f.engine.resolve({reused:true,engine:{source:'ok',revision:'x',resources:[descriptor.entry_url]}});await quiet;await visible;
  assert.equal(f.progress.length,0);assert.ok(observed.length>=1);assert.equal(observed.at(-1).done,1);
});
