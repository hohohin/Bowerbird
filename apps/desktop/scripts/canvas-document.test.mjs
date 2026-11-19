import test from 'node:test';
import assert from 'node:assert/strict';
import { readCanvasNote, canvasNoteValue } from '../src/lib/canvasNotes.ts';
import { compileGenerationPrompt, newWorkflowNode } from '../src/lib/canvasWorkflow.ts';

const markdown = '# 剧本\n\n**第一幕**\n\n- 开场\n- 远景\n\n<img data-bowerbird-asset="photo-b" data-caption="配色" />\n\n> 第二幕\n\n<img data-bowerbird-asset="photo-a" data-caption="构图" />\n';
const note = () => readCanvasNote({ payloadJson: JSON.stringify({ schema_version: 1, note_type: 'document', title: '剧本', text: markdown, cells: [], member_ids: [] }) });

test('document cards keep the complete document rather than materializing a table cell', () => {
  const value = note();
  assert.equal(value.note_type, 'document');
  assert.equal(value.text, markdown);
  assert.deepEqual(value.cells, []);
  assert.deepEqual(readCanvasNote({ payloadJson: JSON.stringify(value) }), value);
});

test('document text and image ports project the same ordered document as readable text', () => {
  const value = note();
  const text = canvasNoteValue(value, '*text');
  assert.match(text.text, /^剧本\n第一幕/);
  assert.match(text.text, /开场\n+远景/);
  assert.match(text.text, /第二幕/);
  assert.ok(text.text.indexOf('@图片1') < text.text.indexOf('@图片2'));
  assert.doesNotMatch(text.text, /data-bowerbird-asset/);
  assert.deepEqual(text.assetIds, ['photo-b', 'photo-a']);
  assert.deepEqual(text.imageRefs, [{ asset_id: 'photo-b', token: '@图片1' }, { asset_id: 'photo-a', token: '@图片2' }]);
  assert.deepEqual(canvasNoteValue(value, '*'), { type: 'image', assetIds: ['photo-b', 'photo-a'] });
  assert.equal(canvasNoteValue(value, 'cell-0-0'), undefined);
  value.text = '无图';
  assert.deepEqual(canvasNoteValue(value, '*').assetIds, []);
  assert.equal(canvasNoteValue(value, '*text').text, '无图');
  value.text = '<audio data-bowerbird-asset="sound" data-caption="" />\n\n<img data-bowerbird-asset="photo" data-caption="" />\n';
  assert.deepEqual(canvasNoteValue(value, '*').assetIds, ['photo'], 'audio never becomes an image output');
});

test('generation compiles the document reference with ordered images and readable text', () => {
  const textInput = { canvasNodeId: 'script', cellId: '*text' };
  const imageInput = { canvasNodeId: 'script', cellId: '*' };
  const generation = { ...newWorkflowNode('generation', 0, 0, 'codex'),
    inputs: { text: [textInput], image: [imageInput] }, prompt: '@[script-text]\n使用 @[script-images] 生成开场',
    promptReferences: [{ id: 'script-text', type: 'text', input: textInput, label: '剧本' }, { id: 'script-images', type: 'image', input: imageInput, label: '图片' }],
  };
  const compiled = compileGenerationPrompt(generation, { text: [canvasNoteValue(note(), '*text')], image: [canvasNoteValue(note(), '*')] });
  assert.deepEqual(compiled.assetIds, ['photo-b', 'photo-a']);
  assert.match(compiled.prompt, /剧本\n第一幕/);
  assert.match(compiled.prompt, /使用 @图片1 @图片2 生成开场/);
  assert.doesNotMatch(compiled.prompt, /data-bowerbird-asset|bowerbird-table/);
});

 test('document output removes syntax without truncating text or changing stored content',()=>{
 const value=note();value.text='# 标题\n\n**粗体**和[链接](https://example.com)\n\n- [x] 完成\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n\n```js\nconst n = 1;\n```\n\n'+ '长文'.repeat(1000);
 const original=value.text, output=canvasNoteValue(value,'*text').text;
 assert.doesNotMatch(output, /\*\*|\[x\]|https:|```|^#|\|/m);
 for(const part of ['标题','粗体和链接','完成','甲 · 乙','const n = 1;','长文'.repeat(1000)]) assert.ok(output.includes(part));
 assert.equal(value.text,original);
 });
