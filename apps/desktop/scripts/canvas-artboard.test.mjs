import assert from "node:assert/strict";
import { test } from "node:test";
import { artboardComposition, artboardCompositionPrompt, containArtboardImage } from "../src/lib/canvasArtboard.ts";
import { readCanvasNote } from "../src/lib/canvasNotes.ts";
import { projectCanvasAssetIds } from "../src/lib/creativeCanvas.ts";

const asset = id => ({ id, name: id, store_path: `/${id}.png`, width: 1000, height: 500 });
const frame = { x: 100, y: 200, width: 500, height: 250 };
const image = (id, x, y, width, height, order = 1, nodeId = id) => ({ nodeId, asset: asset(id), rect: { x, y, width, height }, order });
test("relative pixels, clipping, alpha-size box and repeated original mapping", () => {
  const plan = artboardComposition(frame, asset("model"), [image("earring", 150, 220, 20, 30, 2, "right"),
    image("earring", 90, 210, 20, 30, 1, "left"), image("outside", 700, 200, 20, 30)]);
  assert.deepEqual([plan.width, plan.height], [1000, 500]);
  assert.equal(plan.images.length, 2);
  assert.deepEqual(plan.references.map(asset => asset.id), ["model", "earring"]);
  assert.deepEqual(plan.images.map(image => image.reference), [4, 4]);
  assert.deepEqual(plan.images[0].box, { x: -20, y: 20, width: 40, height: 60 });
  assert.deepEqual(plan.images[0].visibleBox, { x: 0, y: 20, width: 20, height: 60 });
  const prompt = artboardCompositionPrompt(plan, "给人物戴上耳饰");
  assert.match(prompt, /红框 1.*参考图4/); assert.match(prompt, /红框 2.*参考图4/);
  assert.match(prompt, /最终图中不要出现编号、红框/);
});
test("blank frame, outside-only rejection, image limits and raster memory cap", () => {
  assert.throws(() => artboardComposition(frame, null, []), /请先/);
  assert.throws(() => artboardComposition(frame, null, [image("outside", 600, 200, 20, 30)]), /请先/);
  const plan = artboardComposition(frame, null, [image("earring", 150, 220, 20, 30)]);
  assert.equal(plan.images[0].reference, 3);
  assert.throws(() => artboardComposition(frame, null, Array.from({ length: 9 }, (_, n) => image(String(n), 150, 220, 20, 30))), /最多/);
  const large = artboardComposition({ ...frame, width: 100000, height: 100000 }, asset("model"), []);
  assert.ok(large.width <= 2048 && large.height <= 2048);
});
test("object-fit geometry and frame metadata survive reading and asset hydration", () => {
  assert.deepEqual(containArtboardImage({ x: 10, y: 20, width: 100, height: 100 }, 200, 100), { x: 10, y: 45, width: 100, height: 50 });
  const payloadJson = JSON.stringify({ schema_version: 1, text: "画板", note_type: "section", cells: [], member_ids: [], artboard: { base_asset_id: "model" } });
  assert.deepEqual(readCanvasNote({ payloadJson }).artboard, { base_asset_id: "model" });
  assert.deepEqual(projectCanvasAssetIds([{ kind: "note", assetId: null, payloadJson }, { kind: "asset", assetId: "model" }]), ["model"]);
});
