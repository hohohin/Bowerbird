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
const { creationSchema: schema, imageAttrs } = await import("../src/components/creation/schema.ts");
const { serializeDoc } = await import("../src/components/creation/serialize.ts");
const { parsePromptToDoc } = await import("../src/components/creation/parse.ts");
test("historical prompt load retains exact selected instances and first/last order", () => {
  const refs = ["first", "last"].map(id => ({ id, name: id, ext: "png", store_path: `/${id}.png` }));
  const assets = new Map(refs.map(asset => [asset.id, asset]));
  const doc = schema.topNodeType.create(null, schema.nodes.paragraph.create(null, refs.map((asset, index) => schema.nodes.image.create({ ...imageAttrs(asset.id, asset, false), canvasNodeId: `selected-instance-${index}` }))));
  const saved = serializeDoc(doc, assets);
  const restored = parsePromptToDoc(saved.finalPrompt, saved.references, assets, undefined, [], saved.referenceNodeIds);
  const replay = serializeDoc(restored, assets);
  assert.deepEqual(replay.referenceNodeIds, ["selected-instance-0", "selected-instance-1"]);
  assert.deepEqual(replay.references.map(asset => asset.id), ["first", "last"]);
  assert.equal(replay.finalPrompt, saved.finalPrompt);
});
test("old history with no instance IDs stays explicit null instead of guessing an instance", () => {
  const asset = { id: "same-asset", name: "reference", ext: "png", store_path: "/same.png" };
  const assets = new Map([[asset.id, asset]]);
  const restored = parsePromptToDoc("@reference.png", [asset], assets);
  assert.deepEqual(serializeDoc(restored, assets).referenceNodeIds, [null]);
});

test("readonly reference aliases resolve renamed files without consuming adjacent prose", () => {
  const refs = [{ id: "a", name: "旧名", ext: "png" }, { id: "b", name: "参考", ext: "jpg" }];
  const assets = new Map(refs.map(asset => [asset.id, asset]));
  const aliases = new Map([["a", ["新名", "result-original.png"]]]);
  for (const label of ["旧名.png", "新名.png", "result-original.png"]) {
    const doc = parsePromptToDoc(`@${label}的光影和 @参考.jpg的色彩，保留正文。`, refs, assets, undefined, [], [], aliases);
    assert.equal(doc.textContent, "的光影和 的色彩，保留正文。");
    const images = [];
    doc.descendants(node => { if (node.type.name === "image") images.push([node.attrs.assetId, node.attrs.silent]); });
    assert.deepEqual(images, [["a", false], ["b", false]]);
  }
});

test("reference aliases keep duplicate filename ordinals and leave unknown labels untouched", () => {
  const refs = [{ id: "a", name: "旧图甲", ext: "png" }, { id: "b", name: "旧图乙", ext: "png" }];
  const assets = new Map(refs.map(asset => [asset.id, asset]));
  const aliases = new Map([["a", ["同名图"]], ["b", ["同名图"]]]);
  const doc = parsePromptToDoc("@同名图.png 的构图 @同名图#2.png 的颜色 @未关联.png", refs, assets, undefined, [], [], aliases);
  const images = [];
  doc.descendants(node => { if (node.type.name === "image") images.push(node.attrs.assetId); });
  assert.deepEqual(images, ["a", "b"]);
  assert.equal(doc.textContent, " 的构图  的颜色 @未关联.png");
});

test("ambiguous alternate names never overwrite primary reference labels", () => {
  const refs = [{ id: "a", name: "主图", ext: "png" }, { id: "b", name: "辅图", ext: "png" }];
  const assets = new Map(refs.map(asset => [asset.id, asset]));
  const doc = parsePromptToDoc("@主图.png", refs, assets, undefined, [], [], new Map([["b", ["主图"]]]));
  assert.equal(doc.firstChild.firstChild.attrs.assetId, "a");
});
