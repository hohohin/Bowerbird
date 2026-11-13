import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentMediaMarkup, documentMediaReferences, documentWorkflowValue } from '../src/lib/documentProjection.ts';
import { documentReadingHtml } from '../src/lib/documentPreview.ts';

test('canvas prose keeps paragraph boundaries and the last line in compact text blocks', () => {
  const paragraphs = Array.from({ length: 1250 }, (_, i) => `第 ${i + 1} 段。`);
  const reading = documentReadingHtml(paragraphs.join('\r\n\r\n'));
  const chunks = [...reading.matchAll(/<span class="canvas-document-prose">([^<]*)<\/span>/g)];
  assert.ok(chunks.length > 1 && chunks.length < paragraphs.length / 10);
  assert.equal(chunks.map(match => match[1]).join('\n\n'), paragraphs.join('\n\n'));
  assert.match(documentReadingHtml('今天\n天气很好。'), /今天 天气很好。/);
  assert.match(documentReadingHtml('A &amp; B'), /canvas-document-prose">A &amp; B</);
});

test('semantic Markdown still renders as structure wherever it occurs in a long document', () => {
  const lead = '普通正文。\n\n'.repeat(200);
  for (const [syntax, tag] of [
    ['标题\n---', '<h2>'], ['2) 有序项目', '<ol start="2">'], ['- 列表', '<ul>'],
    ['| 表头 |\n| --- |\n| 表格 |', '<table>'], ['    保留缩进', '<pre>'], ['**强调**', '<strong>'],
    ['第一行  \n下一行', '<br>'], ['www.example.com', '<u>'],
  ]) assert.ok(documentReadingHtml(lead + syntax).includes(tag), syntax);
});

test('document keeps Markdown order and captions while projecting ordered media identities', () => {
  const source = '# 场景\n\n**近景**\n\n' + documentMediaMarkup({ kind: 'image', assetId: 'first', caption: '光线', sourcePath: 'D:/private/photo.webp' }) + '\n\n> 保持节奏\n\n' + documentMediaMarkup({ kind: 'image', assetId: 'second', caption: '' }) + '\n\n- 收尾\n';
  const result = documentWorkflowValue(source);
  assert.equal(result.text, '# 场景\n\n**近景**\n\n@图片1（光线）\n\n> 保持节奏\n\n@图片2\n\n- 收尾\n');
  assert.deepEqual(result.assetIds, ['first', 'second']);
  assert.deepEqual(result.imageRefs, [{ asset_id: 'first', token: '@图片1' }, { asset_id: 'second', token: '@图片2' }]);
  assert.ok(!result.text.includes('private'));
});
test('repeated image retains each position but uses one attachment; audio/video remain explicit', () => {
  const refs = [{kind:'image',assetId:'a',caption:''},{kind:'audio',assetId:'b',caption:'旁白'},{kind:'image',assetId:'a',caption:''},{kind:'video',assetId:'c',caption:'动作'}];
  const source = refs.map(documentMediaMarkup).join('\n\n');
  assert.deepEqual(documentMediaReferences(source).map(ref => [ref.kind,ref.assetId]), refs.map(ref => [ref.kind,ref.assetId]));
  assert.deepEqual(documentWorkflowValue(source).assetIds, ['a','b','c']);
  assert.equal((documentWorkflowValue(source).text.match(/@图片1/g) || []).length, 2);
});
test('code fences, malformed markup and external links remain literal and do not become attachments', () => {
  const tag = documentMediaMarkup({kind:'image',assetId:'a',caption:''});
  const source = '```html\n'+tag+'\n```\n\n<img data-bowerbird-asset="%BAD" data-caption="" />\n\n![remote](https://example.test/a.png)';
  assert.deepEqual(documentMediaReferences(source), []);
  assert.equal(documentWorkflowValue(source).text, source);
  assert.equal(documentWorkflowValue('').text, '');
});
test('legacy controlled image references and CRLF preserve source text boundaries', () => {
  const source = '## Hi\r\n\r\n![caption](bowerbird-asset:asset%20id)\r\n\r\nEnd';
  assert.deepEqual(documentMediaReferences(source).map(ref => ref.assetId), ['asset id']);
  assert.equal(documentWorkflowValue(source).text, '## Hi\r\n\r\n@图片1（caption）\r\n\r\nEnd');
});
test('raw frontmatter and adjacent HTML are not document media blocks', () => {
  const tag = documentMediaMarkup({kind:'image',assetId:'a',caption:''});
  for (const source of ['---\n\n'+tag+'\n\n---\n', '<div>\n'+tag+'\n</div>', '    '+tag]) {
    assert.deepEqual(documentMediaReferences(source), []);
    assert.equal(documentWorkflowValue(source).text, source);
  }
});

test('fenced source examples stay literal and the first media block after a real closing fence is live', () => {
  const example = documentMediaMarkup({ kind: 'image', assetId: 'example', caption: '' });
  const live = documentMediaMarkup({ kind: 'image', assetId: 'live', caption: '正文' });
  for (const [opening, closing] of [['```html', '```'], ['  ~~~markdown', '  ~~~'], ['````', '`````']]) {
    const code = `${opening}\n\n${example}\n\n${closing}\n\n`;
    const source = code + live;
    assert.deepEqual(documentMediaReferences(source).map(ref => ref.assetId), ['live']);
    assert.equal(documentWorkflowValue(source).text, code + '@图片1（正文）');
  }
  for (const falseClosing of ['```', '~~~~', '```` still code']) {
    const code = `\`\`\`\`html\n\n${example}\n\n${falseClosing}\n\n${example}\n\n\`\`\`\`\n\n`;
    assert.deepEqual(documentMediaReferences(code + live).map(ref => ref.assetId), ['live']);
    assert.equal(documentWorkflowValue(code + live).text, code + '@图片1（正文）');
  }
});

test('one-sided raw HTML, indented code and an unfinished fence never become attachments', () => {
  const tag = documentMediaMarkup({ kind: 'image', assetId: 'a', caption: '' });
  for (const source of [`正文\n${tag}\n\n`, `\n\n${tag}\n正文`, `\t${tag}`, `~~~html\n\n${tag}`]) {
    assert.deepEqual(documentMediaReferences(source), []);
    assert.equal(documentWorkflowValue(source).text, source);
  }
  assert.deepEqual(documentMediaReferences('   ' + tag).map(ref => ref.assetId), ['a']);
});

test('an empty frontmatter header ends before a real image and later thematic break', () => {
  const tag = documentMediaMarkup({ kind: 'image', assetId: 'a', caption: '' });
  const source = `---\n---\n\n${tag}\n\n---\n\n后记`;
  assert.deepEqual(documentMediaReferences(source).map(ref => ref.assetId), ['a']);
  assert.equal(documentWorkflowValue(source).text, '---\n---\n\n@图片1\n\n---\n\n后记');
});

test('controlled Unicode metadata round trips without exposing source paths to the generated prompt', () => {
  const reference = { kind: 'video', assetId: '镜头 1/50%', caption: '移动 & "转场"', sourcePath: 'D:/素材/镜头 1.mp4' };
  const source = documentMediaMarkup(reference) + '\r\r正文\r';
  assert.deepEqual(documentMediaReferences(source), [reference]);
  assert.equal(documentWorkflowValue(source).text, '@图片1（移动 & "转场"）\r\r正文\r');
  const malformed = '<img data-bowerbird-asset="a" data-caption="%ZZ" />';
  assert.equal(documentWorkflowValue(malformed).text, malformed);
  assert.deepEqual(documentMediaReferences(malformed), []);
});
