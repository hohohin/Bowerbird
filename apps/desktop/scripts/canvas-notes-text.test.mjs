import test from "node:test";
import assert from "node:assert/strict";
import { canvasGridWeights, canvasTextCsv, canvasNoteValue, readCanvasNote } from "../src/lib/canvasNotes.ts";

const cell = text => ({ text, bold: false, italic: false, align: "left" });

test('mixed cards retain legacy identities and aggregate text/image references independently', () => {
  const note = readCanvasNote({payloadJson:JSON.stringify({note_type:'text',cells:[
    [{...cell('raw\n text'),id:'a'},{...cell(''),id:'b',content_type:'image',image_refs:[{asset_id:'b',token:'@图片1'}]}],
    [{...cell('参考 @图片1'),id:'c',image_refs:[{asset_id:'c',token:'@图片1'}]}, {...cell('另一个 @图片1'),id:'d',image_refs:[{asset_id:'d',token:'@图片1'}]}]
  ]})});
  assert.equal(canvasNoteValue(note,'a').type,'text');
  assert.deepEqual(canvasNoteValue(note,'b'),{type:'image',assetIds:['b']});
  assert.deepEqual(canvasNoteValue(note,'*').assetIds,['b','c','d']);
  const aggregate=canvasNoteValue(note,'*text');
  assert.deepEqual(JSON.parse(aggregate.text).rows,[['raw\n text','@图片1'],['参考 @图片2','另一个 @图片3']]);
  assert.deepEqual(aggregate.table.rows,JSON.parse(aggregate.text).rows);
  assert.deepEqual(aggregate.assetIds,['b','c','d']);
  const legacy=readCanvasNote({payloadJson:JSON.stringify({note_type:'images',cells:[[{...cell(''),id:'stable',image_refs:[{asset_id:'a',token:'@图片1'}]}]]})});
  assert.equal(legacy.cells[0][0].id,'stable');assert.equal(canvasNoteValue(legacy,'stable').type,'image');
  legacy.cells[0][0]={...legacy.cells[0][0],content_type:'text',text:'changed',image_refs:[]};
  assert.equal(canvasNoteValue(legacy,'stable').text,'changed');
});

test("canvasTextCsv quotes commas, quotes and line breaks per RFC 4180", () => {
  assert.equal(canvasTextCsv([[cell("a"), cell("b")], [cell("c"), cell("d")]]), "a,b\nc,d");
  assert.equal(canvasTextCsv([[cell("带,逗号")]]), '"带,逗号"');
  assert.equal(canvasTextCsv([[cell("含\"引号\"")]]), '"含""引号"""');
  assert.equal(canvasTextCsv([[cell("第一行\n第二行")]]), '"第一行\n第二行"');
  assert.equal(canvasTextCsv([[cell(" 空白保留 ")]]), " 空白保留 ");
});

test("canvasGridWeights falls back to equal weights on malformed vectors", () => {
  assert.deepEqual(canvasGridWeights(undefined, 3), [1, 1, 1]);
  assert.deepEqual(canvasGridWeights([2, 1], 2), [2, 1]);
  assert.deepEqual(canvasGridWeights([2], 2), [1, 1]);
  assert.deepEqual(canvasGridWeights([2, 0], 2), [1, 1]);
  assert.deepEqual(canvasGridWeights([2, Number.NaN], 2), [1, 1]);
});

test('single-cell tables remap image references without losing their generation text', () => {
  const note = readCanvasNote({ payloadJson: JSON.stringify({ note_type: 'text', cells: [[{
    ...cell('查看 @图片3\n保持空行\n'), id: 'single', image_refs: [{ asset_id: 'photo', token: '@图片3' }],
  }]] }) });
  const value = canvasNoteValue(note, 'single');
  assert.deepEqual(value.table.rows, [['查看 @图片1\n保持空行\n']]);
  assert.equal(value.text, value.table.rows[0][0]);
  assert.deepEqual(value.imageRefs, [{ asset_id: 'photo', token: '@图片1' }]);
});

test('latest output selects the entire physical last row and follows row insertion and deletion', () => {
  const note = readCanvasNote({ payloadJson: JSON.stringify({ note_type: 'text', cells: [
    [{ ...cell('old'), id: 'old' }, { ...cell(''), content_type: 'image', image_refs: [{ asset_id: 'old-image', token: '@图片1' }] }],
    [{ ...cell('查看 @图片3\n细节'), image_refs: [{ asset_id: 'new-image', token: '@图片3' }] }, { ...cell(''), content_type: 'image', image_refs: [{ asset_id: 'second-image', token: '@图片1' }] }],
  ] }) });
  const latest = canvasNoteValue(note, '*latest');
  assert.deepEqual(latest.table.rows, [['查看 @图片1\n细节', '@图片2']]);
  assert.deepEqual(latest.table.imageCells, [[0, 1]]);
  assert.deepEqual(latest.assetIds, ['new-image', 'second-image']);
  assert.deepEqual(canvasNoteValue(note, '*latest-image'), { type: 'image', assetIds: ['new-image', 'second-image'] });
  note.cells.push([cell(''), cell('')]);
  assert.equal(canvasNoteValue(note, '*latest').text, '');
  assert.deepEqual(canvasNoteValue(note, '*latest').table.rows, [['', '']]);
  assert.deepEqual(canvasNoteValue(note, '*latest-image').assetIds, [], 'empty last row never falls back to historical images');
  note.cells.pop();
  assert.deepEqual(canvasNoteValue(note, '*latest').table, latest.table);
  note.cells.pop();
  assert.deepEqual(canvasNoteValue(note, '*latest-image').assetIds, ['old-image']);
});
