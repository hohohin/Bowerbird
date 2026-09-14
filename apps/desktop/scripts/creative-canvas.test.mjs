import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  assetPayloadJson,
  agentPromptGroupMap,
  canvasSourceColumnCount,
  clampCanvasSourceThumbnailScale,
  hydrateProjectCanvas,
  isCanvasAssetHydrationCurrent,
  newProjectCanvasAssetNode,
  persistedProjectActiveNodeId,
  projectCanvasAssetIds,
  projectGraphNodesWithLiveLayout,
  projectCanvasNodeLayoutUpdate,
  projectCanvasViewInput,
  rehydrateProjectCanvasAssets,
} from "../src/lib/creativeCanvas.ts";

test("deleted asset tombstones disappear from the canvas while graph history survives", () => {
  const deleted = node("deleted", null);
  const hidden = { ...node("hidden", "a"), hiddenAt: 20 };
  const live = node("live", "a");
  const graph = snapshot([deleted, hidden, live]);
  assert.deepEqual(hydrateProjectCanvas(graph, new Map()).nodes.map(node => node.id), ["live"]);
  assert.equal(graph.nodes.length, 3, "projection never removes stored history");
});

test("Agent launch prompts map only to their own group, including removed groups", () => {
  const prompt = { ...node("agent-prompt", null), kind: "prompt" };
  const ordinary = { ...node("ordinary", null), kind: "prompt" };
  const group = { ...node("agent-group", null), kind: "agent_group" };
  const edge = { kind: "input", fromNodeId: prompt.id, toNodeId: group.id };
  assert.deepEqual([...agentPromptGroupMap([prompt, ordinary, group], [edge]).keys()], [prompt.id]);
  assert.equal(agentPromptGroupMap([prompt, { ...group, hiddenAt: 123 }], [edge]).get(prompt.id)?.id, group.id);
  assert.equal(agentPromptGroupMap([prompt, { ...group, threadId: "other" }], [edge]).size, 0);
  assert.equal(agentPromptGroupMap([prompt, ordinary], [edge]).size, 0);
});
import {
  isCreativeComposerDraftMeaningful,
  parseCreativeComposerDraft,
  serializeCreativeComposerDraft,
} from "../src/lib/creativeDraft.ts";
import {
  acknowledgeCreativeReuseRequest,
  creativeLaunchAssetIds,
  creativeLaunchTargetsProject,
  creativePromptLoadForProject,
} from "../src/lib/creativeLaunch.ts";
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

test("canvas source thumbnail scale maps large previews to fewer columns", () => {
  assert.equal(canvasSourceColumnCount(1), 3);
  assert.equal(canvasSourceColumnCount(2), 2);
  assert.equal(canvasSourceColumnCount(3), 1);
  assert.equal(canvasSourceColumnCount(99), 1);
  assert.equal(clampCanvasSourceThumbnailScale(Number.NaN), 2);
});

test("execution graph edges project onto the live asset and group layout", () => {
  const direct = node("node-direct", "asset-direct", 1);
  const grouped = node("node-grouped", "asset-grouped", 2);
  const liveNodes = [
    {
      kind: "asset",
      id: direct.id,
      asset: { id: direct.id, assetId: direct.assetId, name: "直接素材", thumbPath: null, storePath: null, width: 1200, height: 800 },
      x: 410,
      y: 220,
      width: 230,
      height: 180,
      order: 8,
    },
    {
      kind: "folder",
      id: "group-1",
      assets: [{ id: grouped.id, assetId: grouped.assetId, name: "组内素材", thumbPath: null, storePath: null, width: 1200, height: 800 }],
      x: 700,
      y: 330,
      width: 260,
      height: 200,
      order: 9,
    },
  ];

  const projected = projectGraphNodesWithLiveLayout([direct, grouped], liveNodes);

  assert.deepEqual(
    projected.map(({ x, y, width, height, zIndex }) => ({ x, y, width, height, zIndex })),
    [
      { x: 410, y: 220, width: 230, height: 180, zIndex: 8 },
      { x: 700, y: 330, width: 260, height: 200, zIndex: 9 },
    ],
  );
  assert.equal(direct.x, 20, "the persisted graph snapshot stays immutable");
});

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

test("prompt reuse is delivered only to its target project and survives stale acknowledgements", () => {
  const launch = {
    id: "reuse-1",
    projectId: "project-a",
    assetIds: [],
    promptLoad: { prompt: "复用这段提示词", refs: [{ id: "ref-1" }], dimRefs: [] },
  };
  assert.deepEqual(creativePromptLoadForProject(launch, "project-a"), {
    id: "reuse-1",
    prompt: "复用这段提示词",
    refs: [{ id: "ref-1" }],
    dimRefs: [],
  });
  assert.equal(creativePromptLoadForProject(launch, "project-b"), null);
  assert.equal(creativePromptLoadForProject({ ...launch, promptLoad: undefined }, "project-a"), null);

  const pending = { id: "reuse-2", targetProjectId: null, promptLoad: launch.promptLoad };
  assert.equal(acknowledgeCreativeReuseRequest(pending, "reuse-1"), pending);
  assert.equal(acknowledgeCreativeReuseRequest(pending, "reuse-2"), null);
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

// Exercise the actual card JSX and event handlers, including status-dependent controls.
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { selectCloudAgentResultArtifacts } from "../src/lib/cloudAgentResult.ts";

for (const collection of ["promptGraphNodes", "agentGraphNodes"]) {
  test(collection + " cards expose removal only through the context menu in every execution state", () => {
    const source = readFileSync(new URL("../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");
    const file = ts.createSourceFile("CanvasWorkspace.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === collection + ".map") callback = node.arguments[0].getText(file);
      ts.forEachChild(node, visit);
    }
    visit(file);
    assert.ok(callback);
    const code = ts.transpileModule("const render = " + callback + ";", {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const status of ["creating", "running", "awaiting_approval", "failed", "succeeded", "cancelled"]) {
      const removed = [];
      const summary = () => ({ status, jobId: "job", runId: "run" });
      const bindings = { React, X: () => null, selectCloudAgentResultArtifacts, promptNodeSummary: summary, agentGroupSummary: summary,
        cloudAgentRuns: {}, focusedNodeId: null, activeDragId: null, focusedThreadId: null,
        supersededTaskIds: new Set(),
        selectedCanvasNodeIds: new Set(), selectedCanvasNodeIdsRef: { current: new Set() },
        removeNodes: (ids) => removed.push(...ids),
        isOutsideFocusedThread: () => false, moveGraphNode() {}, endGraphNodeDrag() {} };
      const render = new Function(...Object.keys(bindings), code + "; return render;")(...Object.values(bindings));
      const card = render({ id: "card", width: 260, height: 148, x: 0, y: 0, zIndex: 1 });
      const button = React.Children.toArray(card.props.children).find((child) => child.type === "button");
      assert.equal(button, undefined, status + " must not expose inline removal");
      assert.equal(typeof card.props.onContextMenu, "function");
      for (const key of ["Delete", "Backspace"]) {
        const target = {};
        let prevented = false;
        card.props.onKeyDown({ key, target, currentTarget: target, preventDefault() { prevented = true; }, stopPropagation() {} });
        assert.equal(prevented, false);
      }
      assert.deepEqual(removed, []);
      card.props.onKeyDown({ key: "Delete", target: {}, currentTarget: {} });
      assert.equal(removed.length, 0, "nested controls own their keyboard events");
    }
  });
}

import { snapCanvasRect, translateCanvasSelection, exceedsCanvasDragThreshold, isCanvasPanGesture, canvasNodeIdsInRect } from "../src/lib/canvasLogic.ts";

for (const dragKind of ["material", "execution"]) {
  for (const cancel of [false, true]) {
    test("mixed marquee drag from " + dragKind + (cancel ? " cancels both layouts" : " persists both layouts"), async () => {
      const source = readFileSync(new URL("../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");
      const file = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const names = ["selectionAnchors", "translateGraphSelection", "beginNodeDrag", "beginGraphNodeDrag", "moveNode", "moveGraphNode", "endNodeDrag", "endGraphNodeDrag", "persistGraphNodeGeometry"];
      const declarations = [];
      function visit(node) {
        if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(file));
        ts.forEachChild(node, visit);
      }
      visit(file);
      assert.equal(declarations.length, names.length);
      const material = { id: "ref", kind: "asset", asset: { assetId: "asset-ref" }, x: 0, y: 0, width: 100, height: 100, order: 1 };
      const prompt = { id: "prompt", kind: "prompt", x: 200, y: 0, width: 100, height: 100, zIndex: 2, hiddenAt: null, threadId: "t", positionLocked: false };
      const agent = { ...prompt, id: "agent", kind: "agent_group", x: 400 };
      const hidden = { ...prompt, id: "hidden", hiddenAt: 1 };
      const archived = { ...prompt, id: "archived", threadId: "old" };
      const nodesRef = { current: [material] };
      const graphNodesRef = { current: [prompt, agent, hidden, archived] };
      const selectedIds = new Set(["ref", "prompt", "agent"]);
      const writes = [];
      const persisted = [];
      let activated = 0;
      const bindings = {
        agentPromptGroupMap, graphEdges: [],
        activateCanvasMaterial: () => activated++, hitNode: () => null,
        nodesRef, graphNodesRef, threads: [{ id: "old", archivedAt: 1 }],
        selectedCanvasNodeIdsRef: { current: selectedIds }, nodeDragRef: { current: null }, graphNodeDragRef: { current: null },
        spacePressedRef: { current: false }, suppressNodeClickRef: { current: false }, activeCanvasRef: { current: {} },
        nodeRect: (node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }),
        toBoardPoint: (x, y) => ({ x, y }), snapCanvasRect, translateCanvasSelection, exceedsCanvasDragThreshold, isCanvasPanGesture,
        commitNodes: (nodes) => { nodesRef.current = nodes; }, setGraphNodes() {}, focusGraphNode() {}, setSelectedCanvasNodeIds() {},
        setActiveDragId() {}, setGuides() {}, setHover() {}, setFolderDropTargetId() {},
        persistGeometries: (nodes) => persisted.push(...nodes.map((node) => ({ id: node.id, x: node.x, y: node.y }))),
        enqueueWrite: (write) => { writes.push(write()); }, ensureMaterialized: async () => {},
        api: { projectCanvasNodeUpdate: async (id, layout) => { persisted.push({ id, ...layout }); } },
      };
      const code = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const handlers = new Function(...Object.keys(bindings), code + ";return { " + names.join(",") + " };")(...Object.values(bindings));
      const anchors = handlers.selectionAnchors();
      assert.deepEqual(canvasNodeIdsInRect({ x: -10, y: -10, width: 520, height: 120 }, anchors), [...selectedIds]);
      const target = { isConnected: true, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
      const origin = dragKind === "material" ? material : prompt;
      const down = { button: 0, pointerId: 1, timeStamp: 0, clientX: origin.x + 10, clientY: 10, currentTarget: target, stopPropagation() {} };
      const move = { ...down, timeStamp: 10, clientX: down.clientX + 37, clientY: down.clientY + 53 };
      const prefix = dragKind === "material" ? "Node" : "GraphNode";
      handlers["begin" + prefix + "Drag"](down, origin);
      handlers[dragKind === "material" ? "moveNode" : "moveGraphNode"]({ ...down, clientX: down.clientX + 3 });
      assert.equal(nodesRef.current[0].x, 0, "small pointer jitter stays a click");
      handlers[dragKind === "material" ? "moveNode" : "moveGraphNode"](move);
      assert.deepEqual([nodesRef.current[0].x, nodesRef.current[0].y], [37, 53]);
      assert.deepEqual(graphNodesRef.current.slice(0, 2).map((node) => [node.x, node.y]), [[237, 53], [437, 53]]);
      assert.equal(graphNodesRef.current[2], hidden);
      handlers["end" + prefix + "Drag"](move, cancel);
      await Promise.all(writes);
      if (cancel) {
        assert.equal(persisted.length, 0);
        assert.deepEqual([nodesRef.current[0].x, nodesRef.current[0].y], [0, 0]);
        assert.deepEqual(graphNodesRef.current.slice(0, 2).map((node) => [node.x, node.y]), [[200, 0], [400, 0]]);
      } else {
        assert.deepEqual(persisted.map((node) => node.id).sort(), [...selectedIds].sort());
        assert.ok(persisted.every((node) => node.y === 53));
      }
      if (dragKind === "material") {
        handlers.beginNodeDrag(down, nodesRef.current[0]);
        handlers.endNodeDrag({ ...down, timeStamp: 1000 });
        assert.equal(activated, 1, "holding still retains normal click behavior without peeking");
      }
    });
  }
}

for (const grouped of [false, true]) {
test("one undo restores " + (grouped ? "grouped" : "mixed") + " removal without replacing updated execution state", async () => {
  const source = readFileSync(new URL("../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["removeNodes", "undoRemoval"];
  const declarations = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  const asset = { id: "asset-node", kind: "asset", asset: { id: "asset-node", assetId: "a" }, x: 10, y: 20 };
  const original = { id: "asset-node", kind: "asset", hiddenAt: null, x: 10, y: 20, payloadJson: "asset" };
  const prompt = { id: "prompt", kind: "prompt", hiddenAt: null, x: 200, y: 20, payloadJson: "running" };
  const group = { id: "group", kind: "folder", assets: [asset.asset], x: 80, y: 90, width: 240, height: 280, order: 3 };
  const material = grouped ? group : asset;
  let groupPresent = grouped;
  const nodesRef = { current: [material] };
  const graphNodesRef = { current: [original, prompt] };
  const history = { current: [] };
  const stored = new Map([[original.id, original], [prompt.id, prompt]]);
  const writes = [];
  const bindings = {
    nodesRef, graphNodesRef, removalHistoryRef: history, groupsRef: { current: new Map([["group", { id: "group", name: "my group", role: "composition" }]]) },
    groupedAssetNode: (snapshot) => ({ ...asset, asset: snapshot }),
    projectCanvasGroupUpdate: (original, node) => ({ ...original, x: node.x, y: node.y }),
    activeCanvasRef: { current: { id: "project" } }, focusedNodeIdRef: { current: "prompt" },
    setSelectedCanvasNodeIds() {}, setFocusedNodeId() {}, setGraphNodes() {},
    commitNodes: (nodes) => { nodesRef.current = nodes; }, enqueueWrite: (write) => writes.push(write), ensureMaterialized: async () => {},
    api: {
      projectCanvasGroupDelete: async () => { groupPresent = false; },
      projectCanvasGroupCreate: async (value, ids) => { assert.equal(value.name, "my group"); assert.deepEqual(ids, ["asset-node"]); groupPresent = true; return value; },
      projectCanvasNodeRemove: async (id) => {
        if (id === original.id) stored.delete(id);
        else stored.set(id, { ...stored.get(id), hiddenAt: 1, payloadJson: "succeeded" });
      },
      projectCanvasNodeRestore: async (_, id) => {
        const node = stored.get(id);
        if (!node) return null;
        const restored = { ...node, hiddenAt: null };
        stored.set(id, restored);
        return restored;
      },
      projectCanvasNodeCreate: async (node) => { assert.equal(node.id, original.id); stored.set(node.id, node); },
    },
  };
  const code = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handlers = new Function(...Object.keys(bindings), code + "; return { " + names.join(",") + " };")(...Object.values(bindings));
  handlers.removeNodes([material.id, "prompt"]);
  assert.equal(nodesRef.current.length, 0);
  assert.ok(graphNodesRef.current.every((node) => node.hiddenAt != null));
  assert.equal(history.current.length, 1, "mixed removal is one undo step");
  handlers.undoRemoval();
  assert.deepEqual(nodesRef.current, [material]);
  assert.ok(graphNodesRef.current.every((node) => node.hiddenAt == null));
  assert.equal(history.current.length, 0);
  for (const write of writes) await write();
  assert.equal(groupPresent, grouped);
  assert.equal(stored.get("prompt").payloadJson, "succeeded");
  assert.equal(stored.get("prompt").hiddenAt, null);
  assert.deepEqual([stored.get("asset-node").x, stored.get("asset-node").y], [10, 20]);
});

}

test("canvas Ctrl+Z undoes removal without taking over text editing or adding toolbar controls", () => {
  const source = readFileSync(new URL("../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "onKeyDown") handler = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(handler);
  assert.ok(!source.includes("找回已移除卡片"));
  assert.ok(!source.includes("removalUndoCount"));
  const code = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [target, modifier, expected] of [
    [{ tagName: "DIV" }, { ctrlKey: true }, 1],
    [{ tagName: "DIV" }, { metaKey: true }, 1],
    [{ tagName: "INPUT" }, { ctrlKey: true }, 0],
    [{ tagName: "TEXTAREA" }, { ctrlKey: true }, 0],
    [{ tagName: "DIV", isContentEditable: true }, { ctrlKey: true }, 0],
    [{ tagName: "DIV" }, { ctrlKey: true, shiftKey: true }, 0],
  ]) {
    let undone = 0;
    let prevented = 0;
    const bindings = { promptMenuRef: { current: null }, scopedInspectorOpen: false, viewModeRef: { current: "canvas" },
      nodeDragRef: { current: null }, graphNodeDragRef: { current: null }, removalHistoryRef: { current: [{}] },
      document: { querySelector: () => null }, undoRemoval: () => undone++ };
    const onKeyDown = new Function(...Object.keys(bindings), code + ";return onKeyDown;")(...Object.values(bindings));
    onKeyDown({ target, key: "z", code: "KeyZ", ...modifier, preventDefault() { prevented++; } });
    assert.equal(undone, expected);
    assert.equal(prevented, expected);
  }
});

test("prompt menu reuses the selected turn and deletes only its idle conversation", async () => {
  const source = readFileSync(new URL("../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["promptNodeSummary", "promptSessionJobs", "reuseCanvasPrompt", "deletePromptSession"];
  const declarations = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  const node = (id, jobId, kind = "prompt") => ({ id, kind, payloadJson: JSON.stringify({ job_id: jobId, turn_key: "turn-2", text: "snapshot" }) });
  const selected = node("selected", "a");
  const refs = [{ id: "turn-ref" }];
  const dims = [{ id: "dimension-ref" }];
  const jobs = {
    a: { id: "a", projectId: "p", conversationId: "c", turns: [{ turnKey: "turn-1", promptRaw: "wrong" }, { turnKey: "turn-2", promptRaw: "selected prompt", refAssets: refs }], dimAssets: dims },
    b: { id: "b", projectId: "p", conversationId: "c", running: true },
    other: { id: "other", projectId: "p", conversationId: "different" },
    foreign: { id: "foreign", projectId: "q", conversationId: "c" },
  };
  const removed = [], dismissed = [], reused = [], closed = [];
  const state = { genJobs: jobs, activeJobId: "a", reusePromptToBoard: (...args) => reused.push(args), removeGenJob: (id) => dismissed.push(id), setGenPanelOpen: (value) => closed.push(value) };
  const bindings = { useStore: { getState: () => state }, graphNodesRef: { current: [selected, node("version", "b"), node("result", "a", "asset"), node("unrelated", "other"), node("foreign", "foreign")] }, removeNodes: (ids) => removed.push(...ids), setPromptMenu() {} };
  const agent = node("group", "", "agent_group");
  state.cloudAgentRuns = { run: { intentPrompt: "Agent original prompt", referenceAssetIds: ["turn-ref"] } };
  Object.assign(bindings, { agentGroupSummary: () => ({ runId: "run" }), assetById: new Map([["turn-ref", refs[0]]]), agentPromptGroupMap, graphEdges: [] });
  const code = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actions = new Function(...Object.keys(bindings), code + "; return { reuseCanvasPrompt, deletePromptSession };")(...Object.values(bindings));
  actions.reuseCanvasPrompt(selected);
  assert.deepEqual(reused, [["selected prompt", refs, dims, undefined, { media: undefined, videoOptions: undefined, ratio: undefined }]]);
  actions.reuseCanvasPrompt(agent);
  assert.deepEqual(reused[1], ["Agent original prompt", refs, []]);
  delete state.cloudAgentRuns.run;
  bindings.graphEdges.push({ kind: "input", fromNodeId: selected.id, toNodeId: agent.id });
  bindings.graphNodesRef.current.push(agent);
  actions.reuseCanvasPrompt(agent);
  assert.deepEqual(reused[2], ["selected prompt", refs, dims, undefined, { media: undefined, videoOptions: undefined, ratio: undefined }], "persisted launch prompt works before the run is loaded");
  jobs.a.turns[1].media = "video";
  jobs.a.turns[1].videoOptions = { kind: "frames2video", model_version: "seedance2.5", duration: 9, video_resolution: "720p" };
  jobs.a.turns[1].ratio = null;
  actions.reuseCanvasPrompt(selected);
  assert.deepEqual(reused[3][4], { media: "video", videoOptions: jobs.a.turns[1].videoOptions, ratio: undefined }, "selected video options travel with the exact turn");
  actions.deletePromptSession(selected);
  assert.deepEqual(removed, [], "running versions prevent conversation deletion");
  assert.deepEqual(dismissed, []);
  jobs.b.running = false;
  actions.deletePromptSession(selected);
  assert.deepEqual(removed, ["selected", "version"], "results and unrelated conversations stay on the canvas");
  assert.deepEqual(dismissed, ["a", "b"]);
  assert.deepEqual(closed, [false]);
  const persistedVideo = { prompt: "old video prompt", turn_key: "old-turn", ref_assets: refs,
    media: "video", video_options: jobs.a.turns[1].videoOptions, ratio: "21:9" };
  const oldPrompt = { id: "old-prompt", kind: "prompt", payloadJson: JSON.stringify({ job_id: "not-in-recent", turn_key: "old-turn" }) };
  bindings.graphNodesRef.current.push(oldPrompt, { id: "old-output", kind: "asset", assetId: "old-video" });
  bindings.graphEdges.push({ fromNodeId: "old-prompt", toNodeId: "old-output" });
  state.activeProjectId = "p"; state.projectRouteRevision = 1;
  const historyReads = [];
  const historyApi = { generationHistory: async (...args) => { historyReads.push(args); return { turns: [persistedVideo], references: [] }; } };
  const withHistory = { ...bindings, api: historyApi, notify() {}, notifyError() {} };
  const restoredActions = new Function(...Object.keys(withHistory), code + "; return { reuseCanvasPrompt };")(...Object.values(withHistory));
  restoredActions.reuseCanvasPrompt(oldPrompt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(historyReads, [["old-video", "p"]]);
  assert.deepEqual(reused[4], ["old video prompt", refs, [], undefined, { media: "video", videoOptions: persistedVideo.video_options, ratio: "21:9" }]);
  state.genJobs["not-in-recent"] = {
    id: "not-in-recent", media: "image", provider: "codex", lastRatio: "1:1",
    refAssets: [{ id: "latest-ref" }], turns: [{ turnKey: "latest-only", prompt: "latest image prompt", media: "image" }],
  };
  restoredActions.reuseCanvasPrompt(oldPrompt);
  assert.equal(reused.length, 5, "a partially hydrated job must wait for the exact historical turn");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(historyReads, [["old-video", "p"], ["old-video", "p"]]);
  assert.deepEqual(reused[5], reused[4], "a missing older turn retains its own video mode, references, and ratio rather than latest image defaults");
});

test("canvas selection opens dimensions only in creation mode and anchors to the clicked instance", () => {
  const source = readFileSync(new URL("../src/components/CanvasWorkspace.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "activateCanvasMaterial") declaration = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  const code = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const creating of [false, true]) for (const hasDimensions of [false, true]) {
    const events = [], previews = [];
    const anchor = { dataset: { canvasNodeId: "instance" } };
    const otherInstance = { dataset: { canvasNodeId: "other-instance" } };
    const bindings = {
      useStore: { getState: () => ({ boardOpen: creating, genEditing: null, promptedAssets: [{ id: "asset", sections: hasDimensions ? [{ title: "色彩" }] : [] }] }) },
      canvasPrimaryMaterialAction: (active) => active ? "compose" : "preview",
      stageRef: { current: { querySelectorAll: () => [otherInstance, anchor] } },
      BOARD_ASSET_PICK_EVENT: "pick",
      window: { dispatchEvent: (event) => events.push(event) },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
      setCanvasLightbox: (value) => previews.push(value),
    };
    const activate = new Function(...Object.keys(bindings), code + "; return activateCanvasMaterial;")(...Object.values(bindings));
    activate({ id: "instance", kind: "asset", asset: { id: "instance", assetId: "asset", storePath: "image.png" } });
    assert.equal(events.filter((event) => event.type === "pick").length, creating ? 1 : 0);
    const rings = events.filter((event) => event.type === "bowerbird://board-asset-peek");
    assert.equal(rings.length, creating && hasDimensions ? 1 : 0);
    if (rings.length) assert.deepEqual(rings[0].detail, { assetId: "asset", anchor });
    assert.equal(previews.length, creating ? 0 : 1);
  }
});
