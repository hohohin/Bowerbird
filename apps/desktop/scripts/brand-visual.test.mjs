import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeBrandImages, brandOverview, BRAND_OBSERVATION_TASK } from "../src/lib/brandVisual.ts";
const scope = (missing = ["a", "b"]) => ({ assetIds: ["a", "b"], folderId: "f", folderName: "品牌", inFolder: 2, effective: 2 - missing.length, minRequired: 1, missing: missing.map(assetId => ({ assetId, name: assetId, reason: "no_caption" })) });
test("one click analyzes missing images then summarizes the frozen selection", async () => {
  let pending = ["b"]; const calls = [];
  await summarizeBrandImages({ scope: scope(), signal: new AbortController().signal, onProgress: () => {},
    preview: async () => scope(pending), describe: async id => { calls.push(id); pending = []; },
    extract: async ids => { calls.push(ids); return {}; } });
  assert.deepEqual(calls, ["b", ["a", "b"]]);
});
test("analysis failure never starts extraction; a retry reuses completed observations", async () => {
  let pending = ["a", "b"]; let extraction = 0; const analyzed = [];
  const options = { scope: scope(), signal: new AbortController().signal, onProgress: () => {}, preview: async () => scope(pending),
    extract: async () => { extraction++; return {}; }, describe: async id => { analyzed.push(id); if (id === "b") throw new Error("失败"); pending = pending.filter(p => p !== id); } };
  await assert.rejects(summarizeBrandImages(options), /失败/); assert.equal(extraction, 0);
  await summarizeBrandImages({ ...options, describe: async id => { analyzed.push(id); pending = []; } });
  assert.deepEqual(analyzed, ["a", "b", "b"]); assert.equal(extraction, 1);
});
test("stopping after an image prevents the next analysis and extraction", async () => {
  const controller = new AbortController(); const calls = [];
  await assert.rejects(summarizeBrandImages({ scope: scope(), signal: controller.signal, onProgress: () => {}, preview: async () => scope(),
    describe: async id => { calls.push(id); controller.abort(); }, extract: async () => { throw new Error("must not submit"); } }), { name: "AbortError" });
  assert.deepEqual(calls, ["a"]);
});
test("a changing folder is rejected before any newly added image can be sent", async () => {
  let described = 0;
  await assert.rejects(summarizeBrandImages({ scope: scope(), signal: new AbortController().signal, onProgress: () => {},
    preview: async () => ({ ...scope(), assetIds: ["a", "new-private-image"] }), describe: async () => { described++; }, extract: async () => ({}) }), /图片已发生变化/);
  assert.equal(described, 0);
});
test("a successful but unstructured analysis does not masquerade as a usable brand result", async () => {
  await assert.rejects(summarizeBrandImages({ scope: scope(), signal: new AbortController().signal, onProgress: () => {}, preview: async () => scope(),
    describe: async () => {}, extract: async () => { throw new Error("must not submit"); } }), /无法读懂/);
});
test("old engineering summaries become actual style prose, and observations do not invent brand facts", () => {
  assert.equal(brandOverview({ summary: "8 张有效反推素材；3 条视觉规则", rules: [{ category: "palette", value: "低饱和暖白", polarity: "prefer" }] }), "低饱和暖白。");
  assert.equal(BRAND_OBSERVATION_TASK, "bowerbird:brand-visual-observation:v2");
});
