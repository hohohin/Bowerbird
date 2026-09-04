import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  assetPayloadJson,
  hydrateProjectCanvas,
  isCanvasAssetHydrationCurrent,
  newProjectCanvasAssetNode,
  persistedProjectActiveNodeId,
  projectCanvasAssetIds,
  projectCanvasNodeLayoutUpdate,
  projectCanvasViewInput,
  rehydrateProjectCanvasAssets,
} from "../src/lib/creativeCanvas.ts";
import {
  isCreativeComposerDraftMeaningful,
  parseCreativeComposerDraft,
  serializeCreativeComposerDraft,
} from "../src/lib/creativeDraft.ts";
import { creativeLaunchAssetIds, creativeLaunchTargetsProject } from "../src/lib/creativeLaunch.ts";
import {
  acquireCreativeSubmission,
  acknowledgeCreativeContinuation,
  continuationParentAsset,
  expectedCreativeContinuation,
  generationParentLocator,
  latestGenerationOutput,
  resolveContinuationParent,
} from "../src/lib/creativeGeneration.ts";
import { createOrderedWriteJournal, drainOrderedWriteJournal } from "../src/lib/orderedWriteJournal.ts";

function node(id, assetId, index = 0, threadId = `thread-${index % 4}`) {
  return {
    id,
    projectId: "project-a",
    threadId,
    kind: "asset",
    assetId,
    role: "output",
    payloadJson: JSON.stringify({
      schema_version: 1,
      snapshot: { name: `素材 ${index}`, width: 1200, height: 800 },
      execution: { job_id: `job-${index}`, turn_key: `turn-${index}` },
    }),
    x: index * 20,
    y: index * 10,
    width: 190,
    height: 157,
    zIndex: index,
    positionLocked: false,
    hiddenAt: null,
    createdAt: index + 1,
    updatedAt: index + 1,
  };
}

function snapshot(nodes, overrides = {}) {
  const threadIds = [...new Set(nodes.map((item) => item.threadId).filter(Boolean))];
  return {
    canvas: { projectId: "project-a", draftJson: '{"schema_version":1}', createdAt: 1, updatedAt: 1 },
    threads: threadIds.map((id, index) => ({
      id,
      projectId: "project-a",
      title: `线程 ${index + 1}`,
      origin: "direct",
      archivedAt: null,
      createdAt: index + 1,
      updatedAt: index + 1,
    })),
    nodes,
    groups: [],
    groupItems: [],
    edges: [],
    view: null,
    ...overrides,
  };
}

test("one central asset hydrates as two stable instances on one project canvas", () => {
  const asset = { id: "asset-a", name: "中心素材", thumb_path: "thumb.webp", width: 1200, height: 800 };
  const result = hydrateProjectCanvas(
    snapshot([node("node-1", asset.id, 1), node("node-2", asset.id, 2)]),
    new Map([[asset.id, asset]]),
  );
  assert.deepEqual(result.nodes.map((item) => item.id), ["node-1", "node-2"]);
  assert.deepEqual(result.nodes.map((item) => item.kind === "asset" && item.asset.assetId), ["asset-a", "asset-a"]);
});

test("late project asset metadata rehydrates thumbnails without replacing canvas layout", () => {
  const initial = hydrateProjectCanvas(
    snapshot([node("node-1", "asset-1", 1)]),
    new Map(),
  ).nodes;
  const current = [{ ...initial[0], x: 777, y: 333 }];
  const result = rehydrateProjectCanvasAssets(current, new Map([["asset-1", {
    id: "asset-1",
    name: "已加载素材",
    thumb_path: "loaded.webp",
    store_path: "loaded.png",
    width: 2048,
    height: 1024,
  }]]));
  assert.notEqual(result, current);
  assert.equal(result[0].x, 777);
  assert.equal(result[0].y, 333);
  assert.equal(result[0].kind, "asset");
  assert.equal(result[0].asset.thumbPath, "loaded.webp");
  assert.equal(result[0].asset.storePath, "loaded.png");
  assert.equal(rehydrateProjectCanvasAssets(result, new Map()), result);
});

test("late project asset metadata also rehydrates grouped nodes in place", () => {
  const grouped = hydrateProjectCanvas(snapshot([node("node-1", "asset-1", 1)], {
    groups: [{ id: "group-1", projectId: "project-a", name: "素材组", role: null, x: 80, y: 90, width: 204, height: 178, zIndex: 1, createdAt: 1, updatedAt: 1 }],
    groupItems: [{ groupId: "group-1", nodeId: "node-1", ordinal: 0 }],
  }), new Map()).nodes;
  const result = rehydrateProjectCanvasAssets(grouped, new Map([["asset-1", {
    id: "asset-1", name: "组内素材", thumb_path: "group.webp", store_path: "group.png",
  }]]));
  assert.equal(result[0].kind, "folder");
  assert.equal(result[0].assets[0].thumbPath, "group.webp");
});

test("normalized membership hydrates as one material group without duplicate top-level nodes", () => {
  const nodes = [node("node-1", "asset-1", 1), node("node-2", "asset-2", 2)];
  const result = hydrateProjectCanvas(snapshot(nodes, {
    groups: [{ id: "group-1", projectId: "project-a", name: "素材组", role: null, x: 80, y: 90, width: 204, height: 178, zIndex: 1, createdAt: 1, updatedAt: 1 }],
    groupItems: [
      { groupId: "group-1", nodeId: "node-2", ordinal: 1 },
      { groupId: "group-1", nodeId: "node-1", ordinal: 0 },
    ],
  }), new Map());
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].kind, "folder");
  assert.deepEqual(result.nodes[0].assets.map((asset) => asset.id), ["node-1", "node-2"]);
});

test("one project snapshot retains multiple thread nodes and one shared view", () => {
  const result = hydrateProjectCanvas(snapshot([
    node("thread-a-node", "asset-a", 1, "thread-a"),
    node("thread-b-node", "asset-b", 2, "thread-b"),
  ], {
    view: {
      projectId: "project-a", panX: 12, panY: 24, zoom: 1.4, sourcePanelWidth: 420,
      workspaceWidth: 1400, activeNodeId: "thread-b-node", focusedThreadId: "thread-b",
      viewMode: "canvas", timelineScope: "focused", updatedAt: 1,
    },
  }), new Map());
  assert.deepEqual(result.pan, { x: 12, y: 24 });
  assert.deepEqual(result.nodes.map((item) => item.id), ["thread-a-node", "thread-b-node"]);
});

test("project view persistence keeps the selected projection node", () => {
  const input = projectCanvasViewInput(
    "project-a",
    { x: 12, y: 24 },
    1.2,
    360,
    1400,
    "timeline",
    "thread-a",
    "focused",
    "node-a",
  );
  assert.equal(input.activeNodeId, "node-a");
  assert.equal(input.focusedThreadId, "thread-a");
  assert.equal(input.timelineScope, "focused");
});

test("project view persistence never writes a material-group id as active_node_id", () => {
  const graphNodes = [{ id: "node-a" }, { id: "node-b" }];
  assert.equal(persistedProjectActiveNodeId("node-a", graphNodes), "node-a");
  assert.equal(persistedProjectActiveNodeId("group-a", graphNodes), null);
  assert.equal(persistedProjectActiveNodeId(null, graphNodes), null);
});

test("canvas hydration requests every exact asset id without browsing collapse or limits", () => {
  const nodes = Array.from({ length: 1001 }, (_, index) => ({
    kind: "asset",
    assetId: `asset-${index}`,
  }));
  nodes.push({ kind: "asset", assetId: "asset-3" }, { kind: "prompt", assetId: "ignored" });
  const ids = projectCanvasAssetIds(nodes);
  assert.equal(ids.length, 1001);
  assert.equal(ids[0], "asset-0");
  assert.equal(ids[1000], "asset-1000");
});

test("an older exact-asset refresh cannot overwrite a newer graph hydration", () => {
  assert.equal(isCanvasAssetHydrationCurrent(2, 2, ["a", "b"], ["a", "b"]), true);
  assert.equal(isCanvasAssetHydrationCurrent(1, 2, [], ["a", "b"]), false);
  assert.equal(isCanvasAssetHydrationCurrent(2, 2, ["old"], ["new"]), false);
});

test("an older send cannot borrow or consume a newer continuation sidecar", () => {
  const first = { requestId: "request-a", projectId: "project-a", parentAssetId: "asset-a" };
  const replacement = { requestId: "request-b", projectId: "project-a", parentAssetId: "asset-b" };
  assert.equal(expectedCreativeContinuation(first, "request-a", "project-a"), first);
  assert.throws(
    () => expectedCreativeContinuation(replacement, "request-a", "project-a"),
    /续作请求已更新/,
  );
  assert.equal(expectedCreativeContinuation(replacement, null, "project-a"), null);
  assert.equal(acknowledgeCreativeContinuation(replacement, "request-a"), replacement);
});

test("one project submission claim survives composer unmount and remount", async () => {
  const first = acquireCreativeSubmission("project-remount");
  assert.ok(first);
  let providerCalls = 0;
  let releasePrepare;
  const prepare = new Promise((resolve) => { releasePrepare = resolve; });
  const pending = (async () => {
    try {
      await prepare;
      if (first.isCurrent()) providerCalls += 1;
    } finally {
      first.release();
    }
  })();

  // A fresh component instance still observes the module-level claim.
  assert.equal(acquireCreativeSubmission("project-remount"), null);
  releasePrepare();
  await pending;
  assert.equal(providerCalls, 1);

  const second = acquireCreativeSubmission("project-remount");
  assert.ok(second);
  first.release();
  assert.equal(acquireCreativeSubmission("project-remount"), null, "a stale owner cannot release the new claim");
  second.release();
});

test("moving a projected node sends layout only and leaves execution payload server-owned", () => {
  const projected = node("node-instance", "central-asset", 3, "thread-a");
  const hydrated = hydrateProjectCanvas(snapshot([projected]), new Map()).nodes[0];
  assert.equal(hydrated.kind, "asset");
  const payload = JSON.parse(assetPayloadJson(hydrated.asset));
  assert.deepEqual(payload.execution, { job_id: "job-3", turn_key: "turn-3" });
  const layout = projectCanvasNodeLayoutUpdate(hydrated);
  assert.equal("payloadJson" in layout, false);
  assert.deepEqual(layout, {
    x: hydrated.x,
    y: hydrated.y,
    width: hydrated.width,
    height: hydrated.height,
    zIndex: hydrated.order,
    positionLocked: false,
  });

  const input = newProjectCanvasAssetNode("project-a", {
    kind: "asset",
    id: "free-node",
    asset: { id: "free-node", assetId: "central-asset", name: "参考图", thumbPath: null, storePath: null, width: 640, height: 480 },
    x: 10,
    y: 20,
    width: 190,
    height: 172,
    order: 3,
  });
  assert.equal(input.projectId, "project-a");
  assert.equal(input.threadId, null);
  assert.equal(input.assetId, "central-asset");
});

for (const [count, budgetMs] of [[300, 200], [1000, 500]]) {
  test(`${count}-node multi-thread project projection stays within ${budgetMs}ms baseline`, () => {
    const nodes = Array.from({ length: count }, (_, index) => node(`node-${index}`, `asset-${index}`, index));
    const startedAt = performance.now();
    const result = hydrateProjectCanvas(snapshot(nodes), new Map());
    const elapsedMs = performance.now() - startedAt;
    assert.equal(result.nodes.length, count);
    assert.ok(elapsedMs < budgetMs, `${count}-node projection took ${elapsedMs.toFixed(2)}ms`);
  });
}

test("creative launch carries explicit selection while blank project starts empty", () => {
  assert.deepEqual(creativeLaunchAssetIds(false, ["asset-2", "asset-1", "asset-2"]), ["asset-2", "asset-1"]);
  assert.deepEqual(creativeLaunchAssetIds(true, ["asset-2", "asset-1"]), []);
  assert.equal(creativeLaunchTargetsProject({ projectId: "project-a" }, "project-a"), true);
  assert.equal(creativeLaunchTargetsProject({ projectId: "project-a" }, "project-b"), false);
  assert.equal(creativeLaunchTargetsProject(null, "project-a"), false);
});

test("failed canvas writes block newer values and replay in FIFO order", async () => {
  const journal = createOrderedWriteJournal();
  const calls = [];
  let firstAttempt = true;
  let persisted = "initial";
  journal.pending.push(
    async () => {
      calls.push(firstAttempt ? "old:failed" : "old:retried");
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("offline");
      }
      persisted = "old";
    },
    async () => {
      calls.push("new:written");
      persisted = "new";
    },
  );

  await drainOrderedWriteJournal(journal, false);
  assert.equal(persisted, "initial");
  assert.equal(journal.pending.length, 2);
  assert.deepEqual(calls, ["old:failed"]);

  await drainOrderedWriteJournal(journal, true);
  assert.equal(persisted, "new");
  assert.equal(journal.pending.length, 0);
  assert.equal(journal.failure, null);
  assert.deepEqual(calls, ["old:failed", "old:retried", "new:written"]);
});

test("project composer draft uses a versioned envelope", () => {
  const draft = { doc: { type: "doc", content: [] }, refs: [{ id: "asset-1", name: "参考" }] };
  const encoded = serializeCreativeComposerDraft(draft);
  assert.deepEqual(parseCreativeComposerDraft(encoded), draft);
  assert.equal(parseCreativeComposerDraft('{"schema_version":2,"composer":{"refs":[]}}'), null);
});

test("provisional project materializes only for a meaningful composer draft", () => {
  const encode = (doc, refs = []) => serializeCreativeComposerDraft({ doc, refs });
  assert.equal(isCreativeComposerDraftMeaningful('{"schema_version":1}'), false);
  assert.equal(isCreativeComposerDraftMeaningful(encode({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "请参考" }] }],
  })), false);
  assert.equal(isCreativeComposerDraftMeaningful(encode({
    type: "doc",
    content: [{ type: "paragraph" }],
  })), false);
  assert.equal(isCreativeComposerDraftMeaningful(encode({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "做一张海报" }] }],
  })), true);
  assert.equal(isCreativeComposerDraftMeaningful(encode({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "keyword", attrs: { title: "构图" } }] }],
  })), true);
  assert.equal(isCreativeComposerDraftMeaningful(encode({ type: "doc", content: [] }, [{ id: "asset-1" }])), true);
});

test("continuation and historical retry select an explicit parent output", () => {
  const turns = [
    { id: 1, images: ["first.png", "first-b.png"] },
    { id: 2, images: [] },
    { id: 3, images: ["latest.png"] },
  ];
  assert.equal(latestGenerationOutput(turns), "latest.png");
  assert.equal(latestGenerationOutput(turns, 3), "first.png");
  assert.equal(latestGenerationOutput(turns, 1), null);
  const references = [{ id: "library-generated" }, { id: "canvas-output" }];
  assert.deepEqual(continuationParentAsset(references, ["canvas-output"]), { id: "canvas-output" });
  assert.deepEqual(
    continuationParentAsset(references, ["canvas-output", "library-generated"]),
    { id: "canvas-output" },
  );
  assert.equal(continuationParentAsset(references, []), null);
});

test("generation parent locator binds duplicate paths to the selected turn key", () => {
  const turns = [
    { id: 1, turnKey: "turn-1", images: ["D:\\same.png"] },
    { id: 2, turnKey: "turn-2", images: ["D:\\same.png"] },
    { id: 3, turnKey: "turn-3", images: ["D:\\same.png"] },
  ];
  const assets = [{ id: "asset-same", store_path: "d:/same.png" }];
  assert.equal(
    generationParentLocator("job-1", turns, assets).nodeId,
    "gen-output:job-1:turn-3:asset-same",
  );
  assert.equal(
    generationParentLocator("job-1", turns, assets, { beforeTurnId: 3 }).nodeId,
    "gen-output:job-1:turn-2:asset-same",
  );
  assert.equal(
    generationParentLocator("job-1", turns, assets, { atTurnId: 1 }).nodeId,
    "gen-output:job-1:turn-1:asset-same",
  );
});

test("multiple referenced outputs require an explicit causal parent", () => {
  const references = [{ id: "asset-a" }, { id: "asset-b" }, { id: "library-only" }];
  const candidates = [
    { assetId: "asset-a", nodeId: "node-a", threadId: "thread-a" },
    { assetId: "asset-b", nodeId: "node-b", threadId: "thread-b" },
  ];
  assert.throws(() => resolveContinuationParent(references, candidates), /多个画板结果/);
  assert.deepEqual(resolveContinuationParent(references, candidates, { focusedNodeId: "node-b" }), {
    asset: references[1],
    nodeId: "node-b",
    threadId: "thread-b",
  });
  assert.deepEqual(resolveContinuationParent(references, candidates, { focusedThreadId: "thread-a" }), {
    asset: references[0],
    nodeId: "node-a",
    threadId: "thread-a",
  });
  assert.deepEqual(resolveContinuationParent(references, candidates, {
    sidecar: { parentAssetId: "asset-b", parentNodeId: "node-b", threadId: "thread-b" },
    focusedNodeId: "node-a",
  }), {
    asset: references[1],
    nodeId: "node-b",
    threadId: "thread-b",
  });
});

test("continuation acknowledgement cannot consume a newer sidecar", () => {
  const current = { requestId: "new", projectId: "project-a" };
  assert.equal(acknowledgeCreativeContinuation(current, "old"), current);
  assert.equal(acknowledgeCreativeContinuation(current, "new"), null);
});
