import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creationDraftToDocument, documentPromptLoadFromAssets } from '../src/lib/documentComposer.ts';
import { documentMediaReferences } from '../src/lib/documentProjection.ts';

const asset = {id:'a',name:'重复名',ext:'png',store_path:'D:/a.png',sections:[{id:'s',title:'光线',body:'柔和侧光'}]};
test('expansion follows editor nodes and preserves image identity and dimension text', () => {
  const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'# 剧本'},{type:'image',attrs:{assetId:'a',canvasNodeId:'instance-a'}},{type:'keyword',attrs:{assetId:'a',sectionId:'s',title:'光线',body:'旧内容'}}]}]};
  const expanded=creationDraftToDocument({doc,refs:[asset]});
  assert.ok(expanded.markdown.includes('# 剧本'));
  assert.ok(expanded.markdown.includes('data-bowerbird-asset="a"'));
  assert.ok(expanded.markdown.includes('柔和侧光'));
  assert.ok(!expanded.markdown.includes('旧内容'));
});
test('return loads format as Markdown and attaches controlled references without leaking paths', () => {
  const document={title:'剧本',markdown:'# 剧本\n\n**近景**\n\n<img data-bowerbird-asset="a" data-caption="主体" data-source="D%3A%2Fa.png" />\n'};
  const request=documentPromptLoadFromAssets(document,[asset]);
  assert.equal(request.prompt,'# 剧本\n\n**近景**\n\n@图片1（主体）\n');
  assert.equal(request.refs[0].id,'a'); assert.deepEqual(request.refs[0].referenceNames,['图片1']);
  assert.deepEqual(request.dimRefs,[]);
});
test('missing references prevent incomplete prompt replacement', () => {
  assert.throws(()=>documentPromptLoadFromAssets({title:'',markdown:'<img data-bowerbird-asset="missing" data-caption="" />'},[]),/素材.*不可用/);
});
test('return keeps the original canvas image instance for an existing reference', () => {
  const sourceDoc={type:'doc',content:[{type:'paragraph',content:[{type:'image',attrs:{assetId:'a',canvasNodeId:'instance-a'}}]}]};
  const request=documentPromptLoadFromAssets({title:'',markdown:'<img data-bowerbird-asset="a" data-caption="" />'},[asset],sourceDoc);
  assert.deepEqual(request.referenceNodeIds,['instance-a']);
});
test('explicit document nodes preserve colliding asset names and literal reference-like text', () => {
  const assets = [{...asset,name:'图片2'}, {...asset,id:'b',name:'其他'}];
  const request = documentPromptLoadFromAssets({title:'',markdown:'正文 @图片2\n\n<img data-bowerbird-asset="a" data-caption="前景" />\n\n<img data-bowerbird-asset="b" data-caption="" />'},assets);
  const content = request.document.content.flatMap(paragraph => paragraph.content);
  assert.deepEqual(content.filter(node => node.type === 'image').map(node => node.attrs.assetId), ['a','b']);
  assert.equal(content.filter(node => node.type === 'text').map(node => node.text).join(''), '正文 @图片2（前景）');
});

test('explicit editor documents retain blank lines, captions, thumbnails and the original canvas instance', () => {
  const sourceDoc = { content: [{ content: [{ type: 'image', attrs: { assetId: 'a', canvasNodeId: 'canvas-a' } }] }] };
  const request = documentPromptLoadFromAssets({ title: '', markdown: '# 标题\r\n\r\n<img data-bowerbird-asset="a" data-caption="侧光" />\r\n\r\n结束' }, [{ ...asset, thumb_path: 'D:/thumb/a.webp' }], sourceDoc);
  assert.deepEqual(request.document, { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '# 标题' }] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'a', canvasNodeId: 'canvas-a', name: '重复名', ext: 'png', thumb: 'D:/thumb/a.webp' } }, { type: 'text', text: '（侧光）' }] },
    { type: 'paragraph', content: [] },
    { type: 'paragraph', content: [{ type: 'text', text: '结束' }] },
  ] });
  assert.deepEqual(documentPromptLoadFromAssets({ title: '', markdown: '' }, []).document, { type: 'doc', content: [{ type: 'paragraph', content: [] }] });
});

test('empty restored drafts and missing paragraphs open as an unnamed empty document', () => {
  for (const doc of [undefined, null, {}, { type: 'doc', content: [null, { type: 'paragraph' }] }]) {
    const expanded = creationDraftToDocument({ doc, refs: [] });
    assert.equal(expanded.title, '未命名文本');
    assert.equal(expanded.markdown.trim(), '');
  }
});

test('title inference skips empty lines and media and keeps the first forty heading characters', () => {
  const heading = '剧本标题'.repeat(12);
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'a' } }] },
    { type: 'paragraph', content: [{ type: 'text', text: '## ' + heading }] },
    { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
  ] };
  const expanded = creationDraftToDocument({ doc, refs: [asset] });
  assert.equal(expanded.title, heading.slice(0, 40));
  assert.ok(expanded.markdown.endsWith(`## ${heading}\n正文`));
  assert.equal(creationDraftToDocument({ doc: { content: [doc.content[0]] }, refs: [asset] }).title, '未命名文本');
});

test('missing keyword owners and removed sections retain the saved text, while cleared live sections stay cleared', () => {
  const keyword = { type: 'keyword', attrs: { assetId: 'a', sectionId: 's', title: '旧标题', body: '旧内容' } };
  const doc = { content: [{ content: [keyword] }] };
  for (const refs of [[], [{ ...asset, sections: undefined }], [{ ...asset, sections: [] }]]) {
    assert.equal(creationDraftToDocument({ doc, refs }).markdown, '【旧标题】：旧内容');
  }
  assert.equal(creationDraftToDocument({ doc, refs: [{ ...asset, sections: [{ id: 's', title: '', body: '' }] }] }).markdown, '【】：');
});

test('media expansion uses registered types and paths, with the stored node type retained for temporarily missing assets', () => {
  const doc = { content: [{ content: [
    { type: 'image', attrs: { assetId: 'a', ext: 'mp3' } },
    { type: 'image', attrs: { assetId: 'voice', ext: 'png' } },
    { type: 'image', attrs: { assetId: 'movie', ext: 'png' } },
    { type: 'image', attrs: { assetId: 'offline', ext: 'WAV' } },
  ] }] };
  const refs = [asset, { ...asset, id: 'voice', ext: 'MP3', store_path: 'D:/voice.mp3' }, { ...asset, id: 'movie', ext: 'mp4', store_path: 'D:/movie.mp4' }];
  const expanded = creationDraftToDocument({ doc, refs });
  assert.deepEqual(documentMediaReferences(expanded.markdown), [
    { kind: 'image', assetId: 'a', caption: '', sourcePath: 'D:/a.png' },
    { kind: 'audio', assetId: 'voice', caption: '', sourcePath: 'D:/voice.mp3' },
    { kind: 'video', assetId: 'movie', caption: '', sourcePath: 'D:/movie.mp4' },
    { kind: 'audio', assetId: 'offline', caption: '' },
  ]);
});

test('reference loading follows document order, ignores stale non-image instances and rejects disconnected files', () => {
  const document = { title: '', markdown: '<img data-bowerbird-asset="b" data-caption="" />\n\n<img data-bowerbird-asset="a" data-caption="" />' };
  const source = { content: [{ content: [{ type: 'text', attrs: { assetId: 'b', canvasNodeId: 'stale-text' } }, { type: 'image', attrs: { assetId: 'a' } }] }] };
  const request = documentPromptLoadFromAssets(document, [asset, { ...asset, id: 'b' }], source);
  assert.deepEqual(request.refs.map(ref => [ref.id, ...ref.referenceNames]), [['b', '图片1'], ['a', '图片2']]);
  assert.deepEqual(request.referenceNodeIds, [null, null]);
  assert.throws(() => documentPromptLoadFromAssets(document, [asset, { ...asset, id: 'b', store_path: '' }]), /素材.*不可用/);
});
