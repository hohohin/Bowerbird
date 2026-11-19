import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readDocumentState, writeDocumentState } from '../src/lib/documentState.ts';
const block = (extra = {}) => ({ id: 'p', type: 'p', children: [{ text: '正文😀' }], ...extra });
const rich = () => [block({ align: 'center' })];
function changeState(source, change) {
  return source.replace(/bowerbird-document:1:([^ ]+)/, (_, encoded) => {
    const state = JSON.parse(Buffer.from(encoded, 'base64').toString()); change(state);
    return `bowerbird-document:1:${Buffer.from(JSON.stringify(state)).toString('base64')}`;
  });
}
function discussion() {
  return { id: 'd', userId: 'local', isResolved: false, createdAt: new Date('2026-11-06T00:00:00Z'), documentContent: '正文😀', comments: [
    { id: 'c', discussionId: 'd', userId: 'local', isEdited: false, createdAt: new Date('2026-11-06T00:01:00Z'), contentRich: [block()] },
  ] };
}
test('simple Markdown stays readable, rich state is canonical across line endings', () => {
  const plain = '正文😀\n';
  assert.equal(writeDocumentState(plain, [block()]), plain);
  assert.deepEqual(readDocumentState(plain), { source: plain });
  const stored = writeDocumentState(plain, rich());
  assert.deepEqual(readDocumentState(stored).value, rich());
  assert.deepEqual(readDocumentState(stored.replaceAll('\n', '\r\n')).value, rich());
  assert.deepEqual(readDocumentState(stored.replace('正文😀', '外部改写')), { source: '外部改写\n' });
});
test('state preserves nested styles and removes ephemeral media URLs and placeholder ids', () => {
  const value = [block({ children: [{ text: '红字', color: '#f00' }] }), block({ type: 'img', assetId: 'image', url: 'blob:temp', caption: [{ text: '图注' }], placeholderId: 'upload' }), block({ type: 'file', attachmentId: 'file', url: 'asset://temp' })];
  const restored = readDocumentState(writeDocumentState('正文\n', value)).value;
  assert.equal(restored[0].children[0].color, '#f00');
  assert.equal(restored[1].assetId, 'image'); assert.deepEqual(restored[1].caption, [{ text: '图注' }]);
  assert.equal(restored[1].url, undefined); assert.equal(restored[1].placeholderId, undefined); assert.equal(restored[2].url, undefined);
});
test('comment-only changes, replies, dates and resolution survive storage', () => {
  const value = [block()]; value.discussions = [discussion()];
  assert.deepEqual(readDocumentState(writeDocumentState('正文😀\n', value)).value, value);
  value.discussions[0].isResolved = true; value.discussions[0].comments[0].isEdited = true;
  delete value.discussions[0].documentContent;
  assert.deepEqual(readDocumentState(writeDocumentState('正文😀\n', value)).value, value);
});
test('malformed trees and annotations remain literal instead of crashing the editor', () => {
  const value = rich(); value.discussions = [discussion()];
  const source = writeDocumentState('正文😀\n', value);
  const changes = [s=>s.value=null,s=>s.value=[],s=>s.value=[null],s=>s.value=[[]],s=>s.value=[{text:'leaf'}],s=>delete s.value[0].id,s=>s.value[0].type=1,s=>s.value[0].children=[],s=>s.value[0].children=[{text:'leaf',children:[]}],s=>s.hash=1,s=>s.discussions={},s=>s.discussions=[null],s=>delete s.discussions[0].id,s=>s.discussions[0].isResolved='yes',s=>s.discussions[0].createdAt=1,s=>s.discussions[0].createdAt='bad-date',s=>s.discussions[0].comments={},s=>s.discussions[0].comments=[null],s=>s.discussions[0].comments[0].contentRich=[],s=>delete s.discussions[0].comments[0].discussionId];
  for (const change of changes) { const broken = changeState(source, change); assert.deepEqual(readDocumentState(broken), {source: broken}, change.toString()); }
  const badJson = '\n\n<!-- bowerbird-document:1:bm90LWpzb24= -->\n';
  assert.deepEqual(readDocumentState(badJson), {source: badJson});
});
test('deep or oversized state cannot enter Slate', () => {
  const source = writeDocumentState('正文😀\n', rich());
  const deep = changeState(source, s=>{let child={text:'x'};for(let n=0;n<130;n++)child=block({children:[child]});s.value=[child];});
  assert.deepEqual(readDocumentState(deep), {source: deep});
  const many = changeState(source, s=>{s.value=[block({children:Array.from({length:100001},()=>({text:'x'}))})];});
  assert.deepEqual(readDocumentState(many), {source: many});
});

test('valid depth and node limits remain editable', () => {
  const source = writeDocumentState('正文😀\n', rich());
  const deepest = changeState(source, s=>{let child={text:'x'};for(let n=0;n<128;n++)child=block({children:[child]});s.value=[child];});
  assert.ok(readDocumentState(deepest).value);
  const largest = changeState(source, s=>{s.value=[block({children:Array.from({length:99999},()=>({text:'x'}))})];});
  assert.equal(readDocumentState(largest).value[0].children.length,99999);
});
test('shared native fixture keeps a stable fingerprint including astral characters', async () => {
  const source = await readFile(new URL('fixtures/text-editor-demo/rich-reference.md', import.meta.url),'utf8');
  const restored = readDocumentState(source);
  assert.ok(restored.value);
  assert.match(restored.source,/Reference 图 🐦/);
});
test('comments do not require editor-generated ids and every rich-only shape is retained', () => {
  const value = [block()];value.discussions=[discussion()];delete value.discussions[0].comments[0].contentRich[0].id;
  assert.deepEqual(readDocumentState(writeDocumentState('正文\n',value)).value,value);
  for (const extra of [{caption:[]},{type:'custom'},{url:'https://example.com/image.png'}]) {
    const nodes=[block(extra)];assert.deepEqual(readDocumentState(writeDocumentState('正文\n',nodes)).value,nodes);
  }
  const linked=[block({type:'img',assetId:'asset',url:'asset://temporary'})];
  assert.equal(writeDocumentState('引用\n',linked),'引用\n');
});
