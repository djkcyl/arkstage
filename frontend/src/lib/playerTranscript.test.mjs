import assert from "node:assert/strict";
import test from "node:test";
import { createLogPosition, createReadLogHistory, logDocumentAt } from "../../../build/test/playerTranscript.js";
import { getLogFontSize, setLogFontSize, LOG_FONT_DEFAULT } from "../../../build/test/uiSettings.js";

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};

test("runtime positions keep one-based source lines, including jumps and completed playback", () => {
  const cursor = createLogPosition();
  assert.deepEqual(cursor.read({lineIndex:null,selections:[]}), {lineIndex:null,selections:[]});
  assert.equal(cursor.read({lineIndex:3,selections:[]}).lineIndex, 3);
  assert.equal(cursor.read({lineIndex:87,selections:[]}).lineIndex, 87);
  assert.equal(cursor.read({lineIndex:null,selections:[]}).lineIndex, 87);
  // A native seek or backwards jump must not be replaced by a high-water mark.
  assert.equal(cursor.read({lineIndex:4,selections:[]}).lineIndex, 4);
  cursor.reset();
  assert.equal(cursor.read({lineIndex:null,selections:[]}).lineIndex, null);
});

test("branch changes at the same source line are synchronized without retaining old choices", () => {
  const cursor = createLogPosition();
  const source = {lineIndex:10,selections:[{decisionId:5,optionIndex:0}]};
  const snapshot = cursor.read(source);
  assert.equal(cursor.changed(snapshot), true);
  assert.equal(cursor.changed(cursor.read(source)), false);
  source.selections[0].optionIndex=1;
  assert.equal(snapshot.selections[0].optionIndex, 0);
  assert.equal(cursor.changed(cursor.read(source)), true);
  assert.deepEqual(cursor.read({lineIndex:2,selections:[]}).selections, []);
});

test("an unfinished multiline uses the native prefix without shifting to a future line or another branch", () => {
  const entry = (lineIndex, text) => ({lineIndex,speaker:"博士",source:"multiline",spans:[{text}]});
  const current = entry(8,"第一句第二句");
  const skipped = entry(8,"第一句其他分支");
  const later = entry(90,"第一句再次出现");
  const conditions = {evaluatePartial:(audience,choices)=>audience===0||choices.get(6)===audience-1};
  const document = {conditions,blocks:[
    {kind:"conditional",audience:1,blocks:[{kind:"lines",audience:1,entries:[current]}]},
    {kind:"conditional",audience:2,blocks:[{kind:"lines",audience:2,entries:[skipped]}]},
    {kind:"lines",audience:0,entries:[later]},
  ]};
  const partial = entry(7,"第一句");
  const prefix = {conditions,blocks:[{kind:"lines",audience:1,entries:[partial]}]};
  const position = {lineIndex:7,selections:[{decisionId:6,optionIndex:0}]};
  const shown = logDocumentAt(document,position,()=>prefix);
  assert.equal(shown.conditions, conditions, "prefix condition IDs must not replace the full store");
  assert.equal(shown.blocks[0].blocks[0].entries[0], partial);
  assert.equal(shown.blocks[1].blocks[0].entries[0], skipped);
  assert.equal(shown.blocks[2].entries[0], later);
  assert.equal(document.blocks[0].blocks[0].entries[0], current, "do not mutate the cached complete text");
  const all = logDocumentAt(document,position,()=>prefix,true);
  assert.equal(all.blocks[0].blocks[0].entries[0].lineIndex,7);
  assert.deepEqual(all.blocks[0].blocks[0].entries[0].spans,current.spans,"LOG ALL must retain every fragment while locating the current paragraph");
  assert.equal(logDocumentAt(document,{...position,lineIndex:8},()=>{throw Error("unnecessary prefix analysis")}),document);
  assert.equal(logDocumentAt(document,{...position,lineIndex:null},()=>{throw Error("unnecessary prefix analysis")}),document);
});

test("read LOG follows displayed lines in execution order, without inferring skipped branches or future lines", () => {
  const history=createReadLogHistory();
  for(const line of [null,4,4,7,8,null,13,13,4])history.record(line);
  assert.deepEqual(history.snapshot(),[4,7,8,13,4]);
  const snapshot=history.snapshot();snapshot.push(99);
  assert.deepEqual(history.snapshot(),[4,7,8,13,4]);
  history.reset();assert.deepEqual(history.snapshot(),[]);
});

test("history jumps preserve later visits and restore the choices from that visit", () => {
  const history=createReadLogHistory();
  history.record(3);history.record(10,[{decisionId:7,optionIndex:1}]);history.record(20,[{decisionId:7,optionIndex:1}]);
  const target=history.target(0);
  assert.equal(target.lineIndex,3);assert.equal(target.readCursor,1);assert.deepEqual(target.selections,[]);
  history.restore(target);history.record(3);assert.equal(history.cursor(),1);assert.deepEqual(history.snapshot(),[3,10,20]);
  history.record(10,[{decisionId:7,optionIndex:1}]);assert.equal(history.cursor(),2);assert.deepEqual(history.snapshot(),[3,10,20]);
  history.restore(target);history.record(8,[{decisionId:7,optionIndex:0}]);
  assert.deepEqual(history.snapshot(),[3,10,20,8]);
  assert.deepEqual(history.target(1).selections,[{decisionId:7,optionIndex:1}]);
  assert.deepEqual(history.target(3).selections,[{decisionId:7,optionIndex:0}]);
  const restored=createReadLogHistory();restored.restore(history.target(1));
  assert.equal(restored.cursor(),2);assert.deepEqual(restored.target(3).selections,[{decisionId:7,optionIndex:0}]);
  assert.equal(restored.target(-1),null);assert.equal(restored.target(4),null);
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
