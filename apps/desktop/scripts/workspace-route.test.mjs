import assert from "node:assert/strict";
import test from "node:test";

import {
  backendProjectScopeForRoute,
  isDeferredTaskOpenCurrent,
  isLatestProjectScopeRead,
  isWorkspaceOperationCurrent,
  isWorkspaceSnapshotCurrent,
  projectListReadCrossedRoute,
  resolveWorkspaceProjectId,
  shouldDiscardCreativeTarget,
  shouldRetainInspectorForProjectRoute,
  shouldMountProjectComposer,
  workspaceProjectDeleteMode,
} from "../src/lib/workspaceRoute.ts";
import {
  projectInspectorHeader,
  resolveProjectInspectorPlacement,
  shouldCloseProjectInspectorOnEscape,
} from "../src/lib/projectInspector.ts";

const persisted = { id: "project-persisted" };
const provisional = { id: "project-provisional", provisional: true };
const projects = [persisted, provisional];

test("entering a listed project activates its workspace", () => {
  assert.equal(resolveWorkspaceProjectId(persisted.id, projects), persisted.id);
});

test("a provisional project enters the workspace before it is persisted", () => {
  assert.equal(resolveWorkspaceProjectId(provisional.id, projects), provisional.id);
  assert.equal(backendProjectScopeForRoute(persisted), persisted.id);
  assert.equal(backendProjectScopeForRoute(provisional), null);
});

test("deleting an unmaterialized project discards local state instead of calling persisted deletion", () => {
  assert.equal(workspaceProjectDeleteMode(provisional), "discard-provisional");
  assert.equal(workspaceProjectDeleteMode(persisted), "delete-persisted");
  assert.equal(workspaceProjectDeleteMode(null), "delete-persisted");
});

test("exiting a project always resolves to the library", () => {
  assert.equal(resolveWorkspaceProjectId(persisted.id, projects), persisted.id);
  assert.equal(resolveWorkspaceProjectId(null, projects), null);
});

test("a stale active id cannot leave an orphaned workspace mounted", () => {
  assert.equal(resolveWorkspaceProjectId("deleted-project", projects), null);
});

test("async workspace completion cannot mutate a route that is leaving or already changed", () => {
  assert.equal(isWorkspaceOperationCurrent("project-a", "project-a", false), true);
  assert.equal(isWorkspaceOperationCurrent("project-a", "project-a", true), false);
  assert.equal(isWorkspaceOperationCurrent("project-a", "project-b", false), false);
  assert.equal(isWorkspaceOperationCurrent("project-a", "project-a", false, 4, 5), false);
  assert.equal(isWorkspaceOperationCurrent("project-a", "project-a", false, 5, 5), true);
  assert.equal(isWorkspaceOperationCurrent(null, null, false), true);
  assert.equal(isWorkspaceOperationCurrent(null, "project-a", false), false);
});

test("the matching mount snapshot may restore during its own pending route only", () => {
  assert.equal(isWorkspaceSnapshotCurrent("project-a", "project-a", 7, 7), true);
  assert.equal(isWorkspaceSnapshotCurrent("project-a", "project-b", 7, 7), false);
  assert.equal(isWorkspaceSnapshotCurrent("project-a", "project-a", 7, 8), false);
});

test("project-scoped reads require both the frozen route and the latest request", () => {
  const current = {
    expectedProjectId: "project-a",
    activeProjectId: "project-a",
    routePending: false,
    expectedRouteRevision: 7,
    currentRouteRevision: 7,
    requestId: 3,
    latestRequestId: 3,
  };
  assert.equal(isLatestProjectScopeRead(current), true);
  assert.equal(isLatestProjectScopeRead({ ...current, activeProjectId: "project-b" }), false);
  assert.equal(isLatestProjectScopeRead({ ...current, routePending: true }), false);
  assert.equal(isLatestProjectScopeRead({ ...current, currentRouteRevision: 8 }), false);
  assert.equal(isLatestProjectScopeRead({ ...current, latestRequestId: 4 }), false);
});

test("project list reads that overlap a route never repair away its active project", () => {
  assert.equal(projectListReadCrossedRoute(false, false, 4, 4), false);
  assert.equal(projectListReadCrossedRoute(true, false, 4, 4), true);
  assert.equal(projectListReadCrossedRoute(false, true, 4, 4), true);
  assert.equal(projectListReadCrossedRoute(false, false, 4, 5), true);
});

test("a locator target is discarded only after its project is no longer active or navigating", () => {
  const target = { projectId: "project-a" };
  assert.equal(shouldDiscardCreativeTarget(target, "project-a", null), false);
  assert.equal(shouldDiscardCreativeTarget(target, "project-b", { projectId: "project-a" }), false);
  assert.equal(shouldDiscardCreativeTarget(target, "project-b", null), true);
  assert.equal(shouldDiscardCreativeTarget(target, "project-b", { projectId: "project-b" }), true);
  assert.equal(shouldDiscardCreativeTarget(null, "project-b", null), false);
});

test("a newer task locator survives an older serialized project route commit", () => {
  assert.equal(shouldRetainInspectorForProjectRoute("project-a", null), false);
  assert.equal(shouldRetainInspectorForProjectRoute("project-a", { projectId: "project-b" }), true);
  assert.equal(shouldRetainInspectorForProjectRoute("project-a", { projectId: "project-a" }), true);
});

test("a deferred unowned-task open is cancelled by a newer route intent", () => {
  assert.equal(isDeferredTaskOpenCurrent(4, 4, false), true);
  assert.equal(isDeferredTaskOpenCurrent(4, 4, true), false);
  assert.equal(isDeferredTaskOpenCurrent(4, 5, true), false);
  assert.equal(isDeferredTaskOpenCurrent(4, 5, false), false);
});

test("the project composer never stays mounted behind an execution inspector", () => {
  assert.equal(shouldMountProjectComposer(false, false), true);
  assert.equal(shouldMountProjectComposer(true, false), false);
  assert.equal(shouldMountProjectComposer(false, true), false);
  assert.equal(shouldMountProjectComposer(true, true), false);
});

test("generation and Agent details share one inspector header contract", () => {
  assert.deepEqual(projectInspectorHeader({
    kind: "generation",
    prompt: "\n  夜景海报  \n第二行",
    detail: "2 轮 · 3 图",
    running: true,
  }), {
    kind: "generation",
    title: "夜景海报",
    detail: "2 轮 · 3 图",
    running: true,
    closeLabel: "关闭项目详情",
  });
  assert.equal(projectInspectorHeader({
    kind: "agent",
    prompt: "",
    detail: "等待批准",
    running: false,
  }).title, "Agent 任务详情");
});

test("project inspector Escape yields to nested editing and overlays", () => {
  const base = { key: "Escape", open: true };
  assert.equal(shouldCloseProjectInspectorOnEscape(base), true);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, key: "Enter" }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, open: false }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, defaultPrevented: true }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, targetTagName: "textarea" }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, targetContentEditable: true }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, blockingDialogOpen: true }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, popupOpen: true }), false);
  assert.equal(shouldCloseProjectInspectorOnEscape({ ...base, editing: true }), false);
});

test("project inspector only opens for the exact active project with a thread owner", () => {
  const base = {
    open: true,
    loading: false,
    navigationPending: false,
    activeProjectId: "project-a",
  };
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    execution: { projectId: "project-a", threadId: "thread-a" },
  }), "project");
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    execution: { projectId: "project-b", threadId: "thread-b" },
  }), "hidden");
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    execution: { projectId: "project-a", threadId: null },
  }), "hidden");
});

test("inspector stays hidden while a project route or snapshot is changing", () => {
  const execution = { projectId: "project-a", threadId: "thread-a" };
  assert.equal(resolveProjectInspectorPlacement({
    open: true,
    loading: true,
    navigationPending: false,
    activeProjectId: "project-a",
    execution,
  }), "hidden");
  assert.equal(resolveProjectInspectorPlacement({
    open: true,
    loading: false,
    navigationPending: true,
    activeProjectId: "project-a",
    execution,
  }), "hidden");
});

test("Library fallback accepts only executions without project ownership", () => {
  const base = {
    open: true,
    loading: false,
    navigationPending: false,
    activeProjectId: null,
  };
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    execution: { projectId: null, threadId: null },
  }), "legacy");
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    execution: { projectId: "project-a", threadId: "thread-a" },
  }), "hidden");
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    execution: null,
  }), "hidden");
  assert.equal(resolveProjectInspectorPlacement({
    ...base,
    activeProjectId: "project-a",
    execution: { projectId: null, threadId: null },
  }), "hidden");
});
