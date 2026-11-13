import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {TextDocumentAutosave} from '../src/lib/textDocumentAutosave.ts';
const document={id:'one',title:'原文',markdown:'first',revision:1,updatedAt:1};
const saved=entry=>({...entry,revision:entry.revision+1,updatedAt:Date.now()});
test('staged rich text is serialized once per burst and closing drains edits made during a save', async () => {
  const serialized = [], writes = [];
  let release;
  const firstWrite = new Promise(resolve => { release = resolve; });
  const writer = new TextDocumentAutosave(document, async entry => {
    writes.push(entry.markdown);
    if (writes.length === 1) await firstWrite;
    return saved(entry);
  }, () => {});
  const type = text => writer.stage(() => {
    serialized.push(text);
    writer.update({ ...writer.document, markdown: text });
  });
  type('草'); type('草稿');
  assert.ok(writer.pending);
  assert.deepEqual(serialized, []);
  const closing = writer.flush();
  type('草稿末字');
  release();
  await closing;
  assert.deepEqual(serialized, ['草稿', '草稿末字']);
  assert.deepEqual(writes, serialized);
  assert.equal(writer.pending, false);
});
test('idle edits autosave once without rewriting unchanged content',async()=>{const writes=[],states=[];const writer=new TextDocumentAutosave(document,async entry=>{writes.push(entry);return saved(entry);},s=>states.push(s));writer.update(document);assert.equal(writer.pending,false);writer.update({...document,markdown:'second'});writer.update({...document,title:'标题',markdown:'latest'});await delay(380);assert.equal(writes.length,1);assert.equal(writes[0].markdown,'latest');assert.equal(writes[0].title,'标题');assert.equal(writer.pending,false);assert.equal(states.at(-1),'saved');});
test('close drains edits made while the previous write is pending',async()=>{const writes=[];let release;const writer=new TextDocumentAutosave(document,entry=>{writes.push(entry);return writes.length===1?new Promise(resolve=>release=()=>resolve(saved(entry))):Promise.resolve(saved(entry));},()=>{});writer.update({...document,markdown:'second'});const first=writer.flush();writer.update({...document,markdown:'third'});const closing=writer.flush();release();await Promise.all([first,closing]);assert.deepEqual(writes.map(x=>[x.markdown,x.revision]),[['second',1],['third',2]]);assert.equal(writer.document.markdown,'third');assert.equal(writer.document.revision,3);assert.equal(writer.pending,false);});
test('failed storage keeps the latest draft and retries without a false saved state',async()=>{const states=[];let failure=true;const writer=new TextDocumentAutosave(document,async entry=>{if(failure)throw Error('disk full');return saved(entry);},s=>states.push(s));writer.update({...document,markdown:'keep me'});await assert.rejects(writer.flush(),/disk full/);assert.equal(writer.pending,true);assert.equal(writer.document.markdown,'keep me');assert.equal(states.at(-1),'error');assert(!states.includes('saved'));failure=false;await writer.flush();assert.equal(writer.pending,false);assert.equal(states.at(-1),'saved');});
test('an idle close does not write or change the saved revision',async()=>{let writes=0;const writer=new TextDocumentAutosave(document,async entry=>{writes++;return saved(entry);},()=>{});await writer.flush();assert.equal(writes,0);assert.equal(writer.document.revision,1);});

test('source checkpoints persist even when document text stays the same',async()=>{const writes=[];const writer=new TextDocumentAutosave({...document,sourceVersion:'before'},async entry=>{writes.push(entry);return saved(entry);},()=>{});writer.update({...document,sourceVersion:'after'});await writer.flush();assert.equal(writes[0].sourceVersion,'after');assert.equal(writer.pending,false);});

test('switching to a saved copy cancels the former scheduled write',async()=>{let writes=0;const writer=new TextDocumentAutosave(document,async entry=>{writes++;return saved(entry);},()=>{});writer.update({...document,markdown:'kept in copy'});writer.cancelScheduled();await delay(380);assert.equal(writes,0);assert.equal(writer.document.markdown,'kept in copy');});
