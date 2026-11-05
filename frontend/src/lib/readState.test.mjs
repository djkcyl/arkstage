import assert from 'node:assert/strict';
import test from 'node:test';
import { getReadStories, markRead, setLastWatched, getLastWatched, subscribeReadState } from '../../../build/test/readState.js';
import { createPlaybackCompletion } from '../../../build/test/playbackCompletion.js';
const stored=new Map();
globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
globalThis.window=new EventTarget();

test('old timed markers stay intact but cannot light the completed indicator',()=>{
  stored.clear();stored.set('arkstage-read-stories',JSON.stringify(['old-timer']));
  assert.deepEqual([...getReadStories()],[]);setLastWatched('new-story');assert.equal(getLastWatched(),'new-story');
  assert.equal(getReadStories().has('new-story'),false);
  markRead('new-story');assert.deepEqual([...getReadStories()],['new-story']);
  assert.deepEqual(JSON.parse(stored.get('arkstage-read-stories')),['old-timer']);
});
test('only actual completed playback with displayed content lights the indicator, never time or an internal seek',()=>{
  stored.clear();let updates=0;const unsubscribe=subscribeReadState(()=>updates++);
  const observe=createPlaybackCompletion(()=>markRead('story'));
  for(let i=0;i<1000;i++)observe('waiting_input',true,false);
  observe('error',true,false);observe('finished',false,false);observe('finished',true,true);
  assert.equal(getReadStories().has('story'),false);assert.equal(updates,0);
  observe('finished',true,false);assert.equal(getReadStories().has('story'),true);assert.equal(updates,1);
  observe('finished',true,false);observe('waiting_input',true,false);observe('finished',true,false);
  assert.equal(updates,1,'replaying and rewinding must not duplicate completion events');
  unsubscribe();
});
