import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown, serializeMarkdown } from "./documentCodec.ts";
import type { DocumentValue, PreviewAsset } from "./domain.ts";

const assets: PreviewAsset[] = [
  { id: "image-one", kind: "image", name: "参考.jpg", url: "blob:temporary-image" },
  { id: "audio-one", kind: "audio", name: "声音.wav", url: "blob:temporary-audio" },
  { id: "video-one", kind: "video", name: "动作.mp4", url: "blob:temporary-video" },
];

test("headings, marks, lists and quotes survive editing/source round-trip", () => {
  const markdown = "# 创作说明\n\n一段 **重点** 与 *描述*。\n\n- 配色\n- 光线\n\n> 保持简洁\n";
  const value = parseMarkdown(markdown);
  assert.equal(value[0].type, "h1");
  assert.ok(value.every((block) => block.id));
  const restored = serializeMarkdown(value);
  assert.match(restored, /# 创作说明/);
  assert.match(restored, /\*\*重点\*\*/);
  assert.match(restored, /(?:\*描述\*|_描述_)/);
  assert.match(restored, /[-*] 配色/);
  assert.match(restored, /> 保持简洁/);
});

test("media keeps asset identity, captions and order without persisting blob URLs", () => {
  const value: DocumentValue = assets.map((asset, index) => ({
    id: `block-${index}`, type: asset.kind === "image" ? "img" : asset.kind,
    assetId: asset.id, url: asset.url, caption: `${asset.name} & \"说明\"`, children: [{ text: "" }],
  }));
  const source = serializeMarkdown(value);
  assert.doesNotMatch(source, /blob:/);
  const restored = parseMarkdown(source, assets);
  assert.deepEqual(restored.map((block) => block.assetId), assets.map((asset) => asset.id));
  assert.deepEqual(restored.map((block) => block.url), assets.map((asset) => asset.url));
  assert.deepEqual(restored.map((block) => block.caption), value.map((block) => block.caption));
});

test("unknown HTML and unsupported blocks stay literal and round-trip unchanged", () => {
  const source = '<script>window.pwned = true</script>\n\n```js\nalert("literal")\n```';
  const value = parseMarkdown(source);
  assert.ok(value.every((block) => block.type === "raw"));
  assert.equal(serializeMarkdown(value).trim(), source);
});

test("an unavailable media reference keeps its identity instead of becoming another asset", () => {
  const source = serializeMarkdown([{ id: "missing", type: "audio", assetId: "missing-audio", caption: "待连接", children: [{ text: "" }] }]);
  const restored = parseMarkdown(source, assets);
  assert.equal(restored[0].assetId, "missing-audio");
  assert.equal(restored[0].url, "");
});

test("javascript image URLs never become playable media", () => {
  const value = parseMarkdown('![test](javascript:alert%281%29)');
  assert.equal(value[0].type, "raw");
  assert.match(serializeMarkdown(value), /javascript:/);
});

test("frontmatter, tables, task lists and complex lists retain their literal source", () => {
  for (const source of [
    "---\ntitle: 文档\n---",
    "| A | B |\n|---|---|\n| 一 | 二 |",
    "- [x] 已完成\n- [ ] 待处理",
    "- 第一段\n\n  第二段\n\n- 下一项",
  ]) {
    assert.equal(serializeMarkdown(parseMarkdown(source)).trim(), source);
  }
});

test("unregistered external images remain literal references instead of loading remotely", () => {
  const source = "![远端](https://example.com/image.png)";
  const value = parseMarkdown(source);
  assert.equal(value[0].type, "raw");
  assert.equal(serializeMarkdown(value).trim(), source);
});
