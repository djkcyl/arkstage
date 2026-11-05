import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlaybackResume, savePlaybackResume, clearPlaybackResume } from '../../../build/test/playbackResume.js';

const stored = new Map();
globalThis.localStorage = { getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value) };
test('resume preserves the visited branch and history across reopen but rejects edited scripts',()=>{
  stored.clear();
  const position={lineIndex:19,selections:[{decisionId:7,optionIndex:1}],readLines:[2,5,19]};
  savePlaybackResume('story/NBT','hash-one',position);
  assert.equal(readPlaybackResume('story/NBT','hash-one').lineIndex,19);
  assert.deepEqual(readPlaybackResume('story/NBT','hash-one').selections,position.selections);
  assert.deepEqual(readPlaybackResume('story/NBT','hash-one').readLines,position.readLines);
  assert.equal(readPlaybackResume('story/NBT','hash-two'),null);
  assert.equal(readPlaybackResume('other/NBT','hash-one'),null);
  clearPlaybackResume('story/NBT');assert.equal(readPlaybackResume('story/NBT','hash-one'),null);
});
test('corrupt storage and invalid source/branch positions cannot reach the native seek API',()=>{
  stored.set('prts-playback-resume-v1','broken');assert.equal(readPlaybackResume('story','hash'),null);
  for(const bad of [{lineIndex:-1,selections:[],readLines:[]},{lineIndex:5,selections:[{decisionId:2,optionIndex:-1}],readLines:[]},{lineIndex:5,selections:[],readLines:[null]}]) {
    stored.set('prts-playback-resume-v1',JSON.stringify({story:{...bad,scriptHash:'hash',savedAt:Date.now()}}));
    assert.equal(readPlaybackResume('story','hash'),null);
  }
});
test('rewound bookmarks retain the timeline cursor and sparse choices, including long histories',()=>{
  stored.clear();
  const position={lineIndex:3,selections:[],readLines:Array.from({length:21000},(_,i)=>i+1),readCursor:3,
    choiceHistory:[{index:0,selections:[]},{index:10,selections:[{decisionId:7,optionIndex:1}]}]};
  savePlaybackResume('long','same-script',position);
  const restored=readPlaybackResume('long','same-script');
  assert.equal(restored.readCursor,3);assert.equal(restored.readLines[restored.readCursor-1],restored.lineIndex);
  assert.equal(restored.readLines.length,20000);assert.deepEqual(restored.choiceHistory,position.choiceHistory);
  stored.set('prts-playback-resume-v1',JSON.stringify({bad:{...restored,readCursor:20001}}));
  assert.equal(readPlaybackResume('bad','same-script'),null);
});
