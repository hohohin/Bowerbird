import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown, serializeMarkdown } from '../src/lib/documentCodec.ts';

test('soft Markdown wraps stay soft while explicit hard breaks remain hard', () => {
  assert.equal(serializeMarkdown(parseMarkdown('one\nline')).trim(), 'one line');
  assert.equal(serializeMarkdown(parseMarkdown('> first\n> second')).trim(), '> first second');
  assert.match(serializeMarkdown(parseMarkdown('one  \nline')), /one\\\nline/);
});

test('foreign clipboard media without a library identity does not lose its URL', () => {
  const url = 'https://example.invalid/reference.png';
  assert.match(serializeMarkdown([{id:'foreign',type:'img',url,children:[{text:''}]}]), /https:\/\/example\.invalid\/reference\.png/);
});

test('formatted text, lists and block quotes survive source round-trip', () => {
  const value = parseMarkdown('# 标题\n\n**重点**和*斜体*\n\n- 选项\n\n> 引用\n');
  assert.equal(value[0]?.type, 'h1');
  const source = serializeMarkdown(value);
  assert.match(source, /\*\*重点\*\*/); assert.match(source, /> 引用/);
});
test('all embedded media retain identity, original path and caption without temporary URLs', () => {
  for (const type of ['img', 'audio', 'video']) {
    const value = [{ id:'block', type, assetId:'stable-id', sourcePath:'D:\\素材\\中文 & "原件".mp4', caption:'A [参考] "说明"', url:'blob:temporary', children:[{text:''}] }];
    const source = serializeMarkdown(value);
    assert.doesNotMatch(source, /blob:|asset\.localhost/);
    const restored = parseMarkdown(source)[0];
    assert.equal(restored?.assetId, value[0].assetId);
    assert.equal(restored?.sourcePath, value[0].sourcePath);
    assert.equal(restored?.caption, value[0].caption);
    assert.equal(restored?.type, type);
  }
});
test('unsupported syntax and external resources remain literal, without evaluation', () => {
  for (const source of ['<script>alert(1)</script>', '![x](https://example.invalid/x.png)', '![x](../image.png)', '---\ntitle: hello\n---', '| a | b |\n|---|---|\n| 1 | 2 |', '- [x] done', '~~deleted~~', '- first\n\n  second\n\n- next']) {
    assert.equal(serializeMarkdown(parseMarkdown(source)).trim(), source);
  }
});
test('old preview references can be read without inventing a disk path', () => {
  const value = parseMarkdown('![caption](bowerbird-asset:old-id)');
  assert.equal(value[0]?.assetId, 'old-id');
  assert.equal(value[0]?.sourcePath, undefined);
});
