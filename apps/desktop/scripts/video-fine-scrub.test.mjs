import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScrub, moveScrub } from '../src/lib/videoFineScrub.ts';
test('hold then small movement enters fine without replaying earlier movement',()=>{
 const state=startScrub(100,0);
 assert.equal(moveScrub(state,102,200),2);assert.equal(state.fine,false);
 assert.equal(moveScrub(state,104,450),.5);assert.equal(state.fine,true);
 assert.equal(moveScrub(state,108,470),1);
});
test('fast drag stays coarse even after holding later; a new press resets',()=>{
 const state=startScrub(100,0);assert.equal(moveScrub(state,120,50),20);
 assert.equal(moveScrub(state,106,500),-14);assert.equal(state.fine,false);
 assert.equal(startScrub(106,600).fine,false);
});
test('holding alone and large first movement do not enter fine',()=>{
 const state=startScrub(100,0);assert.equal(moveScrub(state,100,800),0);assert.equal(state.fine,false);
 assert.equal(moveScrub(state,150,900),50);assert.equal(state.fine,false);
});
