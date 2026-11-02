import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import ts from "typescript";
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) { if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(specifier + ".ts", context); throw error; }
  },
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith(".ts")) return result;
    return { ...result, format: "module", source: ts.transpileModule(String(result.source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  },
});
const { mediaType, filterAssetsByMediaType } = await import("../src/lib/mediaFilter.ts");
const { createLocalFileMode, catalogViews } = await import("../src/lib/localFileMode.ts");
const { imageInputError, videoInputError, DEFAULT_VIDEO_OPTIONS } = await import("../src/lib/videoGeneration.ts");

test("text originals never appear in image results, including uppercase and URL suffixes", () => {
  const assets = [
    { id: "image", store_path: "D:/素材/image.png" },
    { id: "video", store_path: "D:/素材/video.mp4" },
    { id: "audio", store_path: "D:/素材/audio.wav" },
    ...["md", "MARKDOWN", "txt"].map(ext => ({ id: ext, store_path: `D:/素材/文档.${ext}?v=2`, thumb_path: "poster.jpg" })),
    { id: "pathless", ext: "md", store_path: null },
  ];
  assert.deepEqual(filterAssetsByMediaType(assets, "image").map(a => a.id), ["image"]);
  assert.deepEqual(filterAssetsByMediaType(assets, "text").map(a => a.id), ["md", "MARKDOWN", "txt", "pathless"]);
  assert.equal(mediaType("file.MD#anchor"), "text");
  assert.equal(filterAssetsByMediaType(assets, null), assets);
});

test("text browsing remembers its independent view across all media and clears image filters", () => {
  const mode = createLocalFileMode();
  mode.getState().setGeneratedFilter("source:generated");
  mode.getState().setMedia("texts");
  assert.equal(mode.getState().mode, "all");
  assert.equal(mode.getState().generatedFilter, null);
  assert.deepEqual(catalogViews("texts"), ["all", "tags", "collections"]);
  mode.getState().setCatalogView("collections");
  mode.getState().setMedia("images");
  assert.equal(mode.getState().mode, "tags");
  mode.getState().setMedia("audios");
  assert.equal(mode.getState().mode, "all");
  mode.getState().setMedia("texts");
  assert.equal(mode.getState().mode, "collections");
});

test("text is rejected as an image/video reference with a useful explanation", () => {
  for (const ext of ["md", "markdown", "txt"]) {
    const ref = [{ name: "提案", store_path: `D:/brief.${ext}` }];
    assert.match(imageInputError(ref), /文本/);
    assert.match(videoInputError({ ...DEFAULT_VIDEO_OPTIONS, kind: "multimodal2video" }, ref), /文本/);
  }
  assert.equal(imageInputError([{ name: "图片", store_path: "D:/image.png" }]), null);
});
