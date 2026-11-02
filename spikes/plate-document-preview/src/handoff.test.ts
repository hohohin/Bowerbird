import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentBlock, DocumentValue, DraftTarget, PreviewAsset } from "./domain.ts";
import { createHandoff, type HandoffInput } from "./handoff.ts";

const assets: PreviewAsset[] = [
  { id: "image-a", name: "林间.jpg", kind: "image", url: "/media/forest.jpg" },
  { id: "image-b", name: "林间.jpg", kind: "image", url: "/media/forest-detail.jpg" },
  { id: "audio-a", name: "环境.wav", kind: "audio", url: "/media/ambient.wav", duration: 12 },
  { id: "video-a", name: "运镜.mp4", kind: "video", url: "/media/motion.mp4" },
];
const paragraph = (id: string, text: string): DocumentBlock => ({ id, type: "p", children: [{ text }] });
const media = (id: string, type: string, assetId: string, caption: string): DocumentBlock => ({
  id, type, assetId, caption, children: [{ text: "" }],
});
const value: DocumentValue = [
  paragraph("intro", "制作森林短片。"),
  media("image-one", "img", "image-a", "参考这张图的配色"),
  paragraph("direction", "使用缓慢的推镜。"),
  media("video-one", "video", "video-a", "参考运镜"),
  media("audio-one", "audio", "audio-a", "保留环境声"),
  media("image-again", "img", "image-a", "结尾再次使用相同配色"),
];
const request = (changes: Partial<HandoffInput> = {}): HandoffInput => ({
  requestId: "request-1", projectId: "project-1", target: "video",
  sourceDocumentAssetId: "document-1", sourceRevision: "revision-1", value, assets, ...changes,
});

test("whole document preserves text, each reference occurrence and captions in document order", () => {
  const result = createHandoff(request());
  assert.equal(result.text, [
    "制作森林短片。", "@图片1：参考这张图的配色", "使用缓慢的推镜。",
    "@视频1：参考运镜", "@音频1：保留环境声", "@图片1：结尾再次使用相同配色",
  ].join("\n\n"));
  assert.deepEqual(result.references.map(ref => ref.asset.id), ["image-a", "video-a", "audio-a"]);
  assert.deepEqual(result.references[0].blockIds, ["image-one", "image-again"]);
  assert.deepEqual(result.source.blockIds, value.map(block => block.id));
  assert.equal(result.mode, "draft");
});

test("selected blocks follow document order, not click order; [] never falls back to whole document", () => {
  const selected = createHandoff(request({ selectedBlockIds: ["image-again", "direction", "video-one"] }));
  assert.equal(selected.text, "使用缓慢的推镜。\n\n@视频1：参考运镜\n\n@图片1：结尾再次使用相同配色");
  assert.deepEqual(selected.source.blockIds, ["direction", "video-one", "image-again"]);
  assert.deepEqual(selected.references.map(ref => ref.asset.id), ["video-a", "image-a"]);
  const empty = createHandoff(request({ selectedBlockIds: [] }));
  assert.equal(empty.text, "");
  assert.deepEqual(empty.references, []);
  assert.deepEqual(empty.source.blockIds, []);
});

test("unsupported media remain visible as references and in the text", () => {
  const result = createHandoff(request({ target: "image" }));
  assert.deepEqual(result.unsupported.map(ref => ref.assetId), ["video-a", "audio-a"]);
  assert.deepEqual(result.references.map(ref => ref.supported), [true, false, false]);
  assert.match(result.text, /@视频1：参考运镜/);
  assert.match(result.text, /@音频1：保留环境声/);
  assert.equal(result.unsupported[1].name, "环境.wav");
});

test("capability mapping keeps video for video target only and never treats audio as an image", () => {
  for (const target of ["chat", "agent", "image", "video"] satisfies DraftTarget[]) {
    const result = createHandoff(request({ target }));
    assert.equal(result.references.find(ref => ref.asset.kind === "image")?.supported, true);
    assert.equal(result.references.find(ref => ref.asset.kind === "audio")?.supported, false);
    assert.equal(result.references.find(ref => ref.asset.kind === "video")?.supported, target === "video");
  }
});

test("missing and unregistered references are reported in-place, never resolved by display name or URL", () => {
  const result = createHandoff(request({ value: [
    media("missing", "img", "missing-id", "缺失原件"),
    { id: "unlinked", type: "video", url: "https://example.invalid/movie.mp4", children: [{ text: "" }] },
  ] }));
  assert.deepEqual(result.missing.map(ref => [ref.blockId, ref.reason]), [
    ["missing", "not-found"], ["unlinked", "unlinked"],
  ]);
  assert.equal(result.references.length, 0);
  assert.match(result.text, /缺失原件/);
  assert.match(result.text, /未连接素材/);
});

test("unknown media nodes and mismatched asset kind are reported instead of becoming image references", () => {
  const result = createHandoff(request({ value: [
    media("unknown", "pdf", "image-a", "文档附件"),
    media("mismatch", "img", "audio-a", "错误的类型"),
  ] }));
  assert.deepEqual(result.missing.map(ref => ref.reason), ["unsupported-block", "kind-mismatch"]);
  assert.deepEqual(result.references, []);
});

test("same filenames still produce separate stable reference labels", () => {
  const result = createHandoff(request({ value: [
    media("one", "img", "image-a", ""), media("two", "img", "image-b", ""),
  ] }));
  assert.deepEqual(result.references.map(ref => [ref.label, ref.asset.id]), [["图片1", "image-a"], ["图片2", "image-b"]]);
  assert.equal(result.text, "@图片1\n\n@图片2");
});

test("nested blocks preserve inline text and selected descendants without duplicate parent content", () => {
  const nested: DocumentValue = [{
    id: "quote", type: "blockquote", children: [
      { id: "line", type: "p", children: [{ text: "保留", bold: true }, { text: "内联文字" }] },
      media("nested-image", "img", "image-a", "嵌套参考"),
    ],
  }];
  assert.equal(createHandoff(request({ value: nested })).text, "保留内联文字\n\n@图片1：嵌套参考");
  const childOnly = createHandoff(request({ value: nested, selectedBlockIds: ["nested-image"] }));
  assert.equal(childOnly.text, "@图片1：嵌套参考");
  assert.deepEqual(childOnly.source.blockIds, ["nested-image"]);
  const both = createHandoff(request({ value: nested, selectedBlockIds: ["nested-image", "quote"] }));
  assert.deepEqual(both.source.blockIds, ["quote"]);
  assert.equal(both.references[0].blockIds.length, 1);
});

test("draft is a snapshot and neither source nodes nor asset objects are mutated or shared", () => {
  const input = structuredClone(request());
  const original = structuredClone(input);
  const result = createHandoff(input);
  assert.deepEqual(input, original);
  input.assets[0].name = "修改后的名字.jpg";
  input.value[0].children[0].text = "修改后的正文";
  input.value.splice(1, 1);
  assert.match(result.text, /^制作森林短片。/);
  assert.equal(result.references[0].asset.name, "林间.jpg");
  result.references[0].asset.url = "/changed.jpg";
  assert.equal(input.assets[0].url, "/media/forest.jpg");
  assert.deepEqual(result.source, { assetId: "document-1", revision: "revision-1", blockIds: original.value.map(block => block.id) });
});
