import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown, serializeMarkdown } from '../src/lib/documentCodec.ts';
import { documentWorkflowValue } from '../src/lib/documentProjection.ts';
import { readDocumentState, writeDocumentState } from '../src/lib/documentState.ts';
const p = (id, text, properties = {}) => ({ id, type: 'p', children: [{ text }], ...properties });

test('malformed state is retained as source instead of entering the editor', () => {
  const original = writeDocumentState('Text\n', [p('first', 'Text', { align: 'center' })]);
  const alter = change => original.replace(/bowerbird-document:1:([^ ]+)/, (_, encoded) => {
    const state = JSON.parse(Buffer.from(encoded, 'base64').toString()); change(state);
    return `bowerbird-document:1:${Buffer.from(JSON.stringify(state)).toString('base64')}`;
  });
  for (const change of [state => state.value = [{ text: 'Not a block' }], state => state.value[0].children = [], state => state.discussions = [{ id: 'bad' }], state => state.hash = 42]) {
    const malformed = alter(change);
    assert.deepEqual(readDocumentState(malformed), { source: malformed });
  }
});

test('diagram source and attachment names remain readable outside rich state', () => {
  const value = [{ id: 'diagram', type: 'code_drawing', data: { code: 'graph TD\nA --> B', drawingType: 'Mermaid' }, children: [{ text: '' }] },
    { id: 'file', type: 'file', name: 'notes.pdf', attachmentId: 'local-file', url: 'blob:temporary', children: [{ text: '' }] }];
  const source = serializeMarkdown(value);
  assert.match(source, /```mermaid\ngraph TD\nA --> B\n```/);
  assert.match(source, /\[notes\.pdf\]\(bowerbird-attachment:local-file\)/);
  assert.equal(parseMarkdown(source)[0].type, 'code_drawing');
});

test('GFM tables, tasks, links and fenced code are editable nodes', () => {
  const value = parseMarkdown('| A | B |\n|---|---|\n| one | two |\n\n- [x] Done\n\n[link](https://example.com)\n\n```js\nconst x = 1;\n```');
  assert.equal(value.some(node => node.type === 'raw'), false);
  assert.ok(value.some(node => node.type === 'table'));
  assert.ok(value.some(node => node.checked === true));
  assert.ok(value.some(node => node.type === 'code_block'));
});

test('rich layout and annotations survive Markdown storage without leaking state into prompts', () => {
  const value = [p('first', 'Colored', { align: 'center', discussion: [{ id: 'comment', text: 'Review' }], children: [{ text: 'Colored', color: '#ff0000', underline: true }] }),
    { id: 'table', type: 'table', colSizes: [180, 240], children: [{ id: 'row', type: 'tr', children: [{ id: 'cell', type: 'td', children: [p('inside', 'Cell')], colSpan: 2 }] }] }];
  const source = serializeMarkdown(value);
  assert.deepEqual(parseMarkdown(source), value);
  assert.match(documentWorkflowValue(source).text, /Colored/);
  assert.doesNotMatch(documentWorkflowValue(source).text, /bowerbird-document|colSizes|comment/);
});

test('editing readable Markdown externally invalidates stale rich state', () => {
  const source = serializeMarkdown([p('first', 'Before', { align: 'right' })]);
  const value = parseMarkdown(source.replace('Before', 'After'));
  assert.equal(value[0].children[0].text, 'After');
  assert.equal(value.some(node => node.type === 'raw'), false, 'stale state must not appear as a source block');
});

test('linked media never stores temporary serving URLs in rich state', () => {
  const value = [{ id: 'image', type: 'img', assetId: 'asset', sourcePath: 'D:/photo.png', url: 'blob:temporary', width: 240, caption: '', children: [{ text: '' }] }];
  const source = serializeMarkdown(value);
  assert.doesNotMatch(source, /blob:temporary/);
  assert.equal(parseMarkdown(source)[0].width, 240);
  assert.deepEqual(documentWorkflowValue(source).assetIds, ['asset']);
});

test('local discussions retain replies, resolved state and dates after reopening', () => {
  const value = [p('first', 'Review this', { children: [{ text: 'Review this', comment_review: true }] })];
  value.discussions = [{ id: 'review', userId: 'local', createdAt: new Date('2026-11-06T00:00:00Z'), isResolved: true,
    comments: [{ id: 'reply', discussionId: 'review', userId: 'local', isEdited: true, createdAt: new Date('2026-11-06T01:00:00Z'), contentRich: [p('reply-body', 'Keep this comment')] }] }];
  const source = serializeMarkdown(value);
  assert.deepEqual(parseMarkdown(source), value);
  assert.doesNotMatch(documentWorkflowValue(source).text, /Keep this comment|bowerbird-document/);
});

test('media nested in columns keeps its identity in downstream references', () => {
  const value = [{ id: 'columns', type: 'column_group', children: [{ id: 'column', type: 'column', width: '50%', children: [
    p('inside', 'Reference'), { id: 'photo', type: 'img', assetId: 'nested-photo', sourcePath: 'D:/nested.png', caption: [{ text: 'Detail' }], url: 'blob:temporary', children: [{ text: '' }] },
  ] }] }];
  const source = serializeMarkdown(value);
  assert.doesNotMatch(source, /blob:temporary/);
  assert.deepEqual(documentWorkflowValue(source).assetIds, ['nested-photo']);
  assert.match(documentWorkflowValue(source).text, /@图片1/);
  assert.equal(parseMarkdown(source)[0].children[0].children[1].assetId, 'nested-photo');
});
