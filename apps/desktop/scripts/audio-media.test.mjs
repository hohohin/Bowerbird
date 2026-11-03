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
const { filterAssetsByMediaType } = await import("../src/lib/mediaFilter.ts");
const { createLocalFileMode, catalogViews } = await import("../src/lib/localFileMode.ts");
const { imageInputError } = await import("../src/lib/videoGeneration.ts");

test("image, video and audio filters remain disjoint even with an image thumbnail", () => {
  const assets = [
    { id: "image", store_path: "D:/素材/image.png" },
    { id: "video", store_path: "D:/素材/video.MP4", thumb_path: "poster.jpg" },
    ...["wav", "MP3", "flac", "m4a", "ogg"].map(ext => ({ id: ext, store_path: `D:/素材/声.${ext}`, thumb_path: "poster.jpg" })),
  ];
  const ids = filter => filterAssetsByMediaType(assets, filter).map(asset => asset.id);
  assert.deepEqual(ids("image"), ["image"]);
  assert.deepEqual(ids("video"), ["video"]);
  assert.deepEqual(ids("audio"), ["wav", "MP3", "flac", "m4a", "ogg"]);
  assert.equal(filterAssetsByMediaType(assets, null), assets);
});

test("audio browsing preserves its own view without changing image or video browsing", () => {
  const mode = createLocalFileMode();
  mode.getState().setMedia("audios");
  assert.deepEqual(catalogViews("audios"), ["all", "tags", "collections"]);
  assert.equal(mode.getState().mode, "all");
  mode.getState().setCatalogView("collections");
  mode.getState().setMedia("videos");
  assert.equal(mode.getState().mode, "tags");
  mode.getState().setMedia("images");
  assert.equal(mode.getState().mode, "tags");
  mode.getState().setMedia("audios");
  assert.equal(mode.getState().mode, "collections");
});

test("audio originals cannot be sent through image generation reference inputs", () => {
  assert.match(imageInputError([{ name: "雨声", store_path: "D:/素材/rain.flac" }]), /音频/);
  assert.equal(imageInputError([{ name: "图片", store_path: "D:/素材/rain.png" }]), null);
});
