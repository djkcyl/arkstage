import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackModes } from "../../../build/test/playbackModes.js";

function native(initial = "default") {
  const value = {mode:initial, buttonSpeedLevel:2, quickSpeedLevel:0, state:"waiting_input"};
  const player = {
    getState:()=>value.state,
    getAutoPlayState:()=>value,
    setAutoPlayMode:mode=>{value.mode=mode},
    setAutoPlaySpeedLevel:level=>{if(value.mode==='quick_play')value.quickSpeedLevel=Math.min(3,level);else value.buttonSpeedLevel=Math.min(2,level)},
  };
  return {value,player,modes:createPlaybackModes(player)};
}

test("manual hold uses native quick mode and returns to manual without changing auto speed",()=>{
  const {value,modes}=native();
  assert.equal(modes.setFastForward(true),true);
  assert.equal(value.mode,'quick_play');
  assert.equal(value.quickSpeedLevel,3);
  assert.deepEqual(modes.state(),{auto:false,fastForward:true,speed:3});
  modes.setFastForward(false);
  assert.equal(value.mode,'default');
  assert.equal(value.buttonSpeedLevel,2);
});

test("a hold restores the user's automatic mode and speed",()=>{
  const {value,modes}=native('button_auto');
  modes.setFastForward(true);
  assert.equal(modes.state().auto,true);
  modes.setFastForward(false);
  assert.equal(value.mode,'button_auto');
  assert.equal(modes.state().speed,3);
  assert.equal(modes.state().fastForward,false);
});

test("releasing at a decision cannot leave its cached quick mode running",()=>{
  const {value,modes}=native();
  modes.setFastForward(true);
  value.state='waiting_decision';value.mode='default';
  modes.setFastForward(false);
  // The native decision resumes its cached mode, then emits displayedLineChange.
  value.mode='quick_play';value.state='waiting_input';
  modes.reconcile();
  assert.equal(value.mode,'default');
  assert.equal(modes.state().fastForward,false);
});

test("hold cannot start on a decision, before start, or after finish",()=>{
  const {value,modes}=native();
  for(const state of ['idle','waiting_decision','finished','error']){
    value.state=state;
    assert.equal(modes.setFastForward(true),false);
    assert.equal(value.mode,'default');
  }
});

test("the manual/auto button ends a temporary quick mode",()=>{
  const {value,modes}=native();
  modes.setFastForward(true);modes.setAuto(true);
  assert.equal(value.mode,'button_auto');
  assert.equal(modes.state().fastForward,false);
  modes.setAuto(false);
  assert.equal(value.mode,'default');
});
