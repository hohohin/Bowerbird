export interface WorkspaceProjectRef {
  id: string;
  provisional?: boolean;
}

export type WorkspaceProjectDeleteMode = "discard-provisional" | "delete-persisted";

/** A provisional workspace has no backend project row yet. Deleting it means
 * discarding local UI state; routing it through the persisted delete commands
 * would fail with NotFound (and flushing first could accidentally materialize it). */
export function workspaceProjectDeleteMode(
  project: WorkspaceProjectRef | null | undefined,
): WorkspaceProjectDeleteMode {
  return project?.provisional ? "discard-provisional" : "delete-persisted";
}

/** Provisional workspaces have no persisted backend owner yet. Entering one
 * must explicitly clear any previous Rust active-project scope. */
export function backendProjectScopeForRoute(project: WorkspaceProjectRef): string | null {
  return project.provisional ? null : project.id;
}

/** A project workspace exists only while the active id still belongs to the project list. */
export function resolveWorkspaceProjectId(
  activeProjectId: string | null,
  projects: readonly WorkspaceProjectRef[],
): string | null {
  if (!activeProjectId) return null;
  return projects.some((project) => project.id === activeProjectId) ? activeProjectId : null;
}

/** The project composer and an execution detail editor must never consume global editor events together. */
export function shouldMountProjectComposer(loading: boolean, inspectorOpen: boolean): boolean {
  return !loading && !inspectorOpen;
}

/** Async work may finish after the user starts leaving its workspace. It can
 * keep running in the task center, but must not mutate the newly active UI. */
export function isWorkspaceOperationCurrent(
  expectedProjectId: string | null,
  activeProjectId: string | null,
  routePending: boolean,
  expectedRouteRevision?: number,
  currentRouteRevision?: number,
): boolean {
  return !routePending
    && expectedProjectId === activeProjectId
    && (expectedRouteRevision == null || expectedRouteRevision === currentRouteRevision);
}

/** Snapshot reads started by the workspace being mounted may finish while the
 * same route is still loading project-scoped chrome. They are current when
 * project identity and the monotonic route revision still match; pending alone
 * is not a reason to reject them. */
export function isWorkspaceSnapshotCurrent(
  expectedProjectId: string,
  activeProjectId: string | null,
  expectedRouteRevision: number,
  currentRouteRevision: number,
): boolean {
  return expectedProjectId === activeProjectId
    && expectedRouteRevision === currentRouteRevision;
}

/** Project-scoped list/projection reads are safe to publish only while both
 * their route identity and latest-wins request token remain current. */
export function isLatestProjectScopeRead(input: {
  expectedProjectId: string | null;
  activeProjectId: string | null;
  routePending: boolean;
  expectedRouteRevision: number;
  currentRouteRevision: number;
  requestId: number;
  latestRequestId: number;
}): boolean {
  return input.requestId === input.latestRequestId
    && isWorkspaceOperationCurrent(
      input.expectedProjectId,
      input.activeProjectId,
      input.routePending,
      input.expectedRouteRevision,
      input.currentRouteRevision,
    );
}

/** A project-list response is stale if its read overlapped any route change,
 * including a route that started before the read and finished before it returned. */
export function projectListReadCrossedRoute(
  routePendingAtRead: boolean,
  routePendingNow: boolean,
  routeRevisionAtRead: number,
  routeRevisionNow: number,
): boolean {
  return routePendingAtRead || routePendingNow || routeRevisionAtRead !== routeRevisionNow;
}

/** A locator request belongs to exactly one project. Once the user has moved
 * elsewhere and no matching navigation is still in flight, retaining it would
 * replay an old node focus when that project is opened again. */
export function shouldDiscardCreativeTarget(
  target: { projectId: string } | null,
  activeProjectId: string | null,
  navigation: { projectId: string } | null,
): boolean {
  return !!target
    && target.projectId !== activeProjectId
    && target.projectId !== navigation?.projectId;
}

/** Any live task locator defers inspector reset until its own serialized route
 * commits. An older route may finish first, but must not erase the newer
 * locator's selected execution while the UI is route-locked. */
export function shouldRetainInspectorForProjectRoute(
  _projectId: string,
  navigation: { projectId: string } | null,
): boolean {
  return navigation != null;
}

/** Opening an unowned legacy task is deferred until the safe Library exit.
 * A newer route request cancels that continuation instead of overwriting the
 * newer task/project intent when the earlier promise settles. */
export function isDeferredTaskOpenCurrent(
  expectedRouteRevision: number,
  currentRouteRevision: number,
  routePending: boolean,
): boolean {
  return !routePending && expectedRouteRevision === currentRouteRevision;
}
