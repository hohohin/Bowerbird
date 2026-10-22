import test from "node:test";
import assert from "node:assert/strict";
import { resolveContinuationParent } from "../src/lib/creativeGeneration.ts";
import { canvasPromptReferences, projectCanvasAssetIds } from "../src/lib/creativeCanvas.ts";
import { canvasConversationTurn } from "../src/lib/canvasConversation.ts";

const references = [{ id: "library" }, { id: "canvas" }];
const candidates = [
  { assetId: "library", nodeId: "library-output", threadId: "old" },
  { assetId: "canvas", nodeId: "canvas-output", threadId: "current" },
  { assetId: "canvas", nodeId: "other-instance", threadId: "other" },
];
test("library picks never infer a parent, even if its generated canvas result is focused", () => {
  assert.equal(resolveContinuationParent([references[0]], candidates, {
    referenceNodeIds: [null], focusedNodeId: "library-output", focusedThreadId: "old",
  }), null);
});
test("mixed picks keep the exact canvas instance and ignore focused library matches", () => {
  assert.deepEqual(resolveContinuationParent(references, candidates, {
    referenceNodeIds: [null, "canvas-output"], focusedNodeId: "library-output", focusedThreadId: "old",
  }), { asset: references[1], nodeId: "canvas-output", threadId: "current" });
});
test("explicit continuation and legacy callers retain their existing parent semantics", () => {
  const expected = { asset: references[0], nodeId: "library-output", threadId: "old" };
  assert.deepEqual(resolveContinuationParent([references[0]], candidates), expected);
  assert.deepEqual(resolveContinuationParent([references[0]], candidates, {
    referenceNodeIds: [null], sidecar: { parentAssetId: "library", parentNodeId: "library-output", threadId: "old" },
  }), expected);
});
test("reference snapshots restore thumbnails, original order and reuse without synthesizing nodes", () => {
  const prompt = { id: "prompt", projectId: "p", threadId: "t", kind: "prompt", payloadJson: JSON.stringify({
    schema_version: 1, job_id: "job", text: "混合引用",
    reference_assets: references.map(asset => ({ asset_id: asset.id, snapshot: { name: `名称-${asset.id}` } })),
  }) };
  const canvas = { id: "canvas-output", projectId: "p", kind: "asset", assetId: "canvas", payloadJson: "{}" };
  const edges = [{ id: "input", projectId: "p", kind: "input", fromNodeId: canvas.id, toNodeId: prompt.id, ordinal: 1 }];
  const nodes = [prompt, canvas];
  const assets = new Map(references.map(asset => [asset.id, { ...asset, name: `当前-${asset.id}`, store_path: `/${asset.id}.png` }]));
  assert.deepEqual(projectCanvasAssetIds(nodes), ["library", "canvas"]);
  assert.deepEqual(canvasPromptReferences(prompt.id, nodes, edges, assets).map(asset => asset.store_path), ["/library.png", "/canvas.png"]);
  const turn = canvasConversationTurn(prompt, nodes, edges, assets, "job");
  assert.deepEqual(turn.references.map(asset => asset.id), ["library", "canvas"]);
  assert.deepEqual(turn.referenceNodeIds, [null, "canvas-output"]);
  const missing = canvasConversationTurn(prompt, nodes, edges, new Map(), "job");
  assert.equal(missing.references[0].name, "名称-library");
  assert.equal(missing.references[0].store_path, null);
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
});
