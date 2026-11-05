import test from 'node:test';
import assert from 'node:assert/strict';
import { tagPickerColumns, normalizeTagName } from '../src/components/assetTagPickerLogic.ts';
const tags = ['自然风景','人像','海报','黑白','产品','AI','包装','壁纸','动物','摄影','123'].map(name => ({ id: name, name }));
test('alphabetical columns keep every group intact and preserve down-then-right order', () => {
  for (const count of [2,3]) {
    const columns = tagPickerColumns(tags, '', count);
    assert.equal(columns.length, count);
    assert.deepEqual(columns.flat().map(g => g.letter), ['A','B','C','D','H','R','S','Z','#']);
    assert.deepEqual(columns.flatMap(c => c.flatMap(g => g.tags.map(t => t.name))), ['AI','包装','壁纸','产品','动物','海报','黑白','人像','摄影','自然风景','123']);
  }
  assert.equal(tags[0].name, '自然风景');
});
test('search matches label text or its initial and normalization avoids duplicate entries', () => {
  assert.deepEqual(tagPickerColumns(tags, 'h', 3).flat().flatMap(g => g.tags.map(t => t.name)), ['海报','黑白']);
  assert.deepEqual(tagPickerColumns(tags, '包装', 2).flat().flatMap(g => g.tags.map(t => t.name)), ['包装']);
  assert.equal(tagPickerColumns(tags, 'missing', 2).flat().length, 0);
  assert.equal(normalizeTagName('  #ＡI '), normalizeTagName('ai'));
  assert.equal(normalizeTagName('### '), '');
});
