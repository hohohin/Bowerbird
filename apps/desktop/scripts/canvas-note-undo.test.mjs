import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreCanvasNoteEdit } from '../src/lib/canvasNoteUndo.ts';

const original = { schema_version: 1, note_type: 'text', text: '', cells: [[
  { id: 'image', content_type: 'image', text: '', image_refs: [{ asset_id: 'saved-image', token: '@图片1' }] },
  { id: 'text', content_type: 'text', text: 'old' },
]] };
const encode = value => JSON.stringify(value);
test('undo clearing an image restores exact saved identity', () => {
  const after = structuredClone(original); after.cells[0][0] = { id: 'image', content_type: 'text', text: '', image_refs: [] };
  assert.equal(restoreCanvasNoteEdit(encode(after), encode(original), encode(after)), encode(original));
});
test('undo restores the image without overwriting a later generated cell or title', () => {
  const after = structuredClone(original); after.cells[0][0] = { id: 'image', content_type: 'text', text: '', image_refs: [] };
  const current = structuredClone(after); current.cells[0][1].text = 'new generated output'; current.title = 'new title';
  const restored = JSON.parse(restoreCanvasNoteEdit(encode(current), encode(original), encode(after)));
  assert.deepEqual(restored.cells[0][0], original.cells[0][0]);
  assert.equal(restored.cells[0][1].text, 'new generated output'); assert.equal(restored.title, 'new title');
});
test('undo row deletion restores missing IDs and retains newer rows', () => {
  const before = structuredClone(original); before.cells.push([{ id: 'deleted-a', text: 'a' }, { id: 'deleted-b', text: 'b' }]);
  const after = structuredClone(original), current = structuredClone(after);
  current.cells[0][1].text = 'new'; current.cells.push([{ id: 'new-a', text: 'later result' }, { id: 'new-b', text: '' }]);
  const restored = JSON.parse(restoreCanvasNoteEdit(encode(current), encode(before), encode(after)));
  assert.equal(restored.cells[0][1].text, 'new');
  assert.deepEqual(restored.cells[1], before.cells[1]); assert.deepEqual(restored.cells[2], current.cells[1]);
});
