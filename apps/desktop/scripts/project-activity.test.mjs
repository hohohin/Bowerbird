import assert from "node:assert/strict";
import test from "node:test";

import {
  agentTaskNavigation,
  clearThreadUnread,
  creativeTaskNavigation,
  creativeTaskOwnerState,
  generationTaskNavigation,
  isAgentTaskActive,
  isProjectNodeNavigable,
  isOutsideFocusedThread,
  markThreadUnread,
  projectGraphVisibility,
  projectTimelineProjection,
  resolveProjectFocusNode,
  resolveProjectFocusThread,
  summarizeProjectActivity,
  taskCenterAgentRuns,
  taskCenterGenerationJobs,
} from "../src/lib/projectActivity.ts";
import {
  agentArtifactNodeId,
  generationOutputNodeId,
} from "../src/lib/projectNodeIds.ts";

test("timeline focus filters only the projection, never the project graph", () => {
  const nodes = [
    { id: "a", threadId: "t1" },
    { id: "b", threadId: "t2" },
    { id: "free", threadId: null },
  ];
  const edges = [
    { id: "e1", threadId: "t1" },
    { id: "e2", threadId: "t2" },
  ];
  const focused = projectTimelineProjection(nodes, edges, "focused", "t1");
  assert.deepEqual(focused.nodes.map((node) => node.id), ["a"]);
  assert.deepEqual(focused.edges.map((edge) => edge.id), ["e1"]);
  assert.equal(nodes.length, 3);
  assert.equal(projectTimelineProjection(nodes, edges, "all", "t1").nodes.length, 3);
});

test("canvas thread focus subdues only nodes owned by another thread", () => {
  assert.equal(isOutsideFocusedThread("t2", "t1"), true);
  assert.equal(isOutsideFocusedThread("t1", "t1"), false);
  assert.equal(isOutsideFocusedThread(null, "t1"), false);
  assert.equal(isOutsideFocusedThread("t2", null), false);
});

test("unread thread sets are idempotent and project scoped", () => {
  const first = markThreadUnread({}, "p1", "t1");
  assert.strictEqual(markThreadUnread(first, "p1", "t1"), first);
  const second = markThreadUnread(first, "p1", "t2");
  assert.deepEqual(second, { p1: ["t1", "t2"] });
  assert.deepEqual(clearThreadUnread(second, "p1", "t1"), { p1: ["t2"] });
  assert.deepEqual(clearThreadUnread(second, "p1"), {});
});

test("project status is derived only from executions with project and thread ownership", () => {
  const summary = summarizeProjectActivity({
    projectId: "p1",
    unreadThreadIds: ["t1", "t1", "t2"],
    generationJobs: [
      { projectId: "p1", threadId: "t1", running: true, turns: [] },
      { projectId: "p1", threadId: null, running: true, turns: [] },
      { projectId: "p1", threadId: "t2", running: false, turns: [{ error: "failed" }] },
    ],
    agentRuns: [
      { projectId: "p1", threadId: "t1", status: "awaiting_approval" },
      { projectId: "p1", threadId: "t2", status: "failed" },
      { projectId: "p2", threadId: "t9", status: "running" },
    ],
  });
  assert.deepEqual(summary, { running: 2, failed: 2, unread: 2 });
});

test("task center keeps only running or failed generation jobs", () => {
  const jobs = [
    { id: "running", projectId: "p1", threadId: "t1", running: true, turns: [] },
    { id: "failed", projectId: null, threadId: null, running: false, turns: [{ error: "boom" }] },
    { id: "succeeded", projectId: "p1", threadId: "t1", running: false, turns: [{ images: ["out.png"] }] },
    { id: "cancelled", projectId: null, threadId: null, running: false, turns: [] },
  ];

  assert.deepEqual(taskCenterGenerationJobs(jobs).map((job) => job.id), ["running", "failed"]);
});

test("task center keeps active, awaiting, and failed Agent runs but not history", () => {
  const runs = [
    { runId: "running", status: "running" },
    { runId: "awaiting", status: "awaiting_result_feedback" },
    { runId: "failed", status: "failed" },
    { runId: "succeeded", status: "succeeded" },
    { runId: "cancelled", status: "cancelled" },
  ];

  assert.deepEqual(taskCenterAgentRuns(runs).map((run) => run.runId), ["running", "awaiting", "failed"]);
  assert.equal(isAgentTaskActive("awaiting_approval"), true);
  assert.equal(isAgentTaskActive("failed"), false);
});

test("task navigation requires both project and thread ownership", () => {
  assert.deepEqual(creativeTaskNavigation({ projectId: "p1", threadId: "t1" }), {
    projectId: "p1",
    threadId: "t1",
    nodeId: null,
  });
  assert.equal(creativeTaskNavigation({ projectId: "p1", threadId: null }), null);
  assert.equal(creativeTaskNavigation({ projectId: null, threadId: "t1" }), null);
  assert.equal(creativeTaskOwnerState({ projectId: "p1", threadId: "t1" }), "owned");
  assert.equal(creativeTaskOwnerState({ projectId: null, threadId: null }), "unowned");
  assert.equal(creativeTaskOwnerState({ projectId: "p1", threadId: null }), "invalid");
  assert.equal(creativeTaskOwnerState({ projectId: null, threadId: "t1" }), "invalid");
});

test("task navigation targets deterministic projection nodes when execution identity is available", () => {
  assert.deepEqual(
    generationTaskNavigation({
      id: "job-1",
      projectId: "p1",
      threadId: "t1",
      running: true,
      turns: [{ turnKey: "turn-old" }, { turnKey: "turn-current" }],
    }),
    { projectId: "p1", threadId: "t1", nodeId: "gen-prompt:job-1:turn-current:0" },
  );
  assert.deepEqual(
    agentTaskNavigation({
      runId: "run-1",
      creativeLaunchId: "launch-1",
      projectId: "p1",
      threadId: "t1",
      status: "running",
    }),
    { projectId: "p1", threadId: "t1", nodeId: "agent-prompt:launch-1:0:0" },
  );
  assert.deepEqual(
    agentTaskNavigation({
      runId: "legacy-run",
      projectId: "p1",
      threadId: "t1",
      status: "failed",
    }),
    { projectId: "p1", threadId: "t1", nodeId: "agent-group:legacy-run:0:0" },
  );
  assert.equal(generationOutputNodeId("job-1", "turn-current", "asset-1"), "gen-output:job-1:turn-current:asset-1");
  assert.equal(agentArtifactNodeId("run-1", "artifact-1"), "agent-artifact:run-1:0:artifact-1");
});

test("generation task navigation never falls back from the latest turn to an older prompt", () => {
  assert.deepEqual(generationTaskNavigation({
    id: "job-1",
    projectId: "p1",
    threadId: "t1",
    running: false,
    turns: [{ turnKey: "turn-old" }, { error: "latest failed before projection" }],
  }), {
    projectId: "p1",
    threadId: "t1",
    nodeId: null,
  });
});

test("external task focus rejects hidden and archived projection nodes", () => {
  const archived = new Set(["thread-archived"]);
  assert.equal(isProjectNodeNavigable({ threadId: "thread-live", hiddenAt: null }, archived), true);
  assert.equal(isProjectNodeNavigable({ threadId: null, hiddenAt: null }, archived), true);
  assert.equal(isProjectNodeNavigable({ threadId: "thread-live", hiddenAt: 12 }, archived), false);
  assert.equal(isProjectNodeNavigable({ threadId: "thread-archived", hiddenAt: null }, archived), false);
});

test("external task focus waits for late projection but consumes an invalid target", () => {
  const archived = new Set(["thread-archived"]);
  const nodes = [
    { id: "ready", threadId: "thread-live", hiddenAt: null },
    { id: "hidden", threadId: "thread-live", hiddenAt: 12 },
    { id: "archived", threadId: "thread-archived", hiddenAt: null },
  ];
  assert.deepEqual(resolveProjectFocusNode(nodes, null, archived), { state: "thread-only", node: null });
  assert.deepEqual(resolveProjectFocusNode(nodes, "late", archived), { state: "pending", node: null });
  assert.equal(resolveProjectFocusNode(nodes, "ready", archived).state, "ready");
  assert.deepEqual(resolveProjectFocusNode(nodes, "hidden", archived), { state: "rejected", node: null });
  assert.deepEqual(resolveProjectFocusNode(nodes, "archived", archived), { state: "rejected", node: null });
  assert.deepEqual(resolveProjectFocusNode(nodes, "ready", archived, "other-thread"), { state: "rejected", node: null });
});

test("thread-only task focus overrides an older saved workspace thread only after hydration", () => {
  const threads = [
    { id: "saved-thread", archivedAt: null },
    { id: "target-thread", archivedAt: null },
    { id: "archived-thread", archivedAt: 12 },
  ];
  assert.equal(resolveProjectFocusThread([], "target-thread"), "pending");
  assert.equal(resolveProjectFocusThread(threads, "target-thread"), "ready");
  assert.equal(resolveProjectFocusThread(threads, "archived-thread"), "rejected");
  assert.equal(resolveProjectFocusThread(threads, null), "rejected");
});

test("archived threads stay out of default canvas/activity but remain explicitly restorable", () => {
  const nodes = [
    { id: "free", threadId: null },
    { id: "active", threadId: "thread-active" },
    { id: "archived", threadId: "thread-archived" },
  ];
  const edges = [
    { id: "active-edge", threadId: "thread-active" },
    { id: "archived-edge", threadId: "thread-archived" },
  ];
  const archived = new Set(["thread-archived"]);
  const defaultProjection = projectGraphVisibility(nodes, edges, archived);
  assert.deepEqual(defaultProjection.nodes.map((node) => node.id), ["free", "active"]);
  assert.deepEqual(defaultProjection.edges.map((edge) => edge.id), ["active-edge"]);

  const restoreProjection = projectGraphVisibility(nodes, edges, archived, "thread-archived");
  assert.deepEqual(restoreProjection.nodes.map((node) => node.id), ["free", "active", "archived"]);
  assert.deepEqual(restoreProjection.edges.map((edge) => edge.id), ["active-edge", "archived-edge"]);
});

test("1000-node multi-thread timeline projection stays within the PB6 baseline", () => {
  const nodes = Array.from({ length: 1000 }, (_, index) => ({
    id: `node-${index}`,
    threadId: `thread-${index % 20}`,
  }));
  const edges = Array.from({ length: 980 }, (_, index) => ({
    id: `edge-${index}`,
    threadId: `thread-${index % 20}`,
  }));
  const started = performance.now();
  const projection = projectTimelineProjection(nodes, edges, "focused", "thread-7");
  const elapsed = performance.now() - started;
  assert.equal(projection.nodes.length, 50);
  assert.equal(projection.edges.length, 49);
  assert.ok(elapsed < 500, `timeline projection took ${elapsed.toFixed(2)}ms`);
});
