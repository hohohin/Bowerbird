import { workflowNodeRun, workflowRunActive, workflowRuns, type CanvasWorkflow, type WorkflowRun } from "./canvasWorkflow";
import { generationPromptNodeId } from "./projectNodeIds";

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  // Native serde_json sorts object keys and omits undefined fields on IPC round trips.
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && same(left[key], right[key]));
}
export { same as sameWorkflowValue };
function mergeValue<T>(before: T, local: T, remote: T): T {
  // Keep live execution objects when the native change only added/removed cards.
  if (same(remote, before) || same(local, remote)) return local;
  if (same(local, before)) return remote;
  throw new Error("同一卡片已有其他修改，请保留当前内容并重新打开项目后核对。");
}

/** Merge additions/removals from chat without dropping queued edits or execution state. */
export function mergeWorkflowChanges(before: CanvasWorkflow, local: CanvasWorkflow, remote: CanvasWorkflow,
  liveGeneration?: (nodeId: string, run: WorkflowRun) => boolean): CanvasWorkflow {
  const baseNodes = new Map(before.nodes.map(node => [node.id, node]));
  const localNodes = new Map(local.nodes.map(node => [node.id, node]));
  const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
  const baseRuns = new Map(workflowRuns(before).map(run => [run.id, run]));
  const localRuns = new Map(workflowRuns(local).map(run => [run.id, run]));
  const remoteRuns = new Map(workflowRuns(remote).map(run => [run.id, run]));
  const staleSteps = new Map<string, Set<string>>();
  const staleLoopRuns = new Set<string>();
  for (const node of liveGeneration ? local.nodes : []) {
    if (node.kind !== "generation" && node.kind !== "comfy-video") continue;
    const run = workflowNodeRun(local, node.id), step = run?.steps[node.id];
    if (!run || !step) continue;
    const baseRun = baseRuns.get(run.id), externalRun = remoteRuns.get(run.id);
    if (!liveGeneration?.(node.id, run) && !(baseRun && liveGeneration?.(node.id, baseRun))) continue;
    const loop = run.loop, externalLoop = externalRun?.loop;
    const iterationDelta = loop && externalLoop?.nodeId === loop.nodeId ? externalLoop.index - loop.index : 0;
    if (iterationDelta > 0) continue;
    const external = externalRun?.steps[node.id];
    const sameAttempt = !!external && (!step.jobId || external.jobId === step.jobId) && (!step.turnKey || external.turnKey === step.turnKey);
    const terminal = external?.status === "done" || external?.status === "failed" || externalRun?.status === "stopped";
    const behind = iterationDelta < 0 || !sameAttempt || run.status === "done" && !!externalRun && workflowRunActive(externalRun) && same(run.order, externalRun.order)
      || !terminal && (step.generationSubmission === "submitted" && external?.generationSubmission !== "submitted"
      || step.status !== "pending" && external?.status === "pending"
      || (step.status === "done" || step.status === "failed" || run.status === "stopped") && externalRun && workflowRunActive(externalRun));
    if (behind) {
      const ids = staleSteps.get(run.id) ?? new Set<string>();
      ids.add(node.id);
      staleSteps.set(run.id, ids);
      if (iterationDelta < 0) staleLoopRuns.add(run.id);
    }
    // An external add may carry an older execution checkpoint for this card.
    // Rebase only execution data; geometry and editable fields still use the ordinary merge.
    const base = baseNodes.get(node.id), other = remoteNodes.get(node.id);
    const session = step.jobId && step.turnKey ? generationPromptNodeId(step.jobId, step.turnKey) : undefined;
    const behindSession = session && node.activeSessionNodeId === session && other?.activeSessionNodeId !== session;
    if (!base || !behind && !behindSession) continue;
    remoteNodes.set(node.id, other ? { ...other, activeSessionNodeId: base.activeSessionNodeId, sessionNodeIds: base.sessionNodeIds,
      outputs: base.outputs, resultNodeIds: base.resultNodeIds } : base);
  }
  const nodes = [...new Set([...localNodes.keys(), ...remoteNodes.keys()])].flatMap(id => {
    const base = baseNodes.get(id), localNode = localNodes.get(id), remoteNode = remoteNodes.get(id);
    // A drag and a native execution checkpoint can update the same card concurrently.
    // Treat x/y as one position, so conflicting moves cannot merge into a third location.
    if (base && localNode && remoteNode && (localNode.x !== remoteNode.x || localNode.y !== remoteNode.y)
        && !same(base, localNode) && !same(base, remoteNode)) {
      const split = ({ x, y, layoutSize, ...definition }: typeof base) => ({ position: { x, y }, definition, layoutSize });
      const original = split(base), ours = split(localNode), theirs = split(remoteNode);
      const definition = mergeValue(original.definition, ours.definition, theirs.definition);
      const position = mergeValue(original.position, ours.position, theirs.position);
      const layoutSize = ours.layoutSize ?? theirs.layoutSize;
      return [{ ...definition, ...position, ...(layoutSize ? { layoutSize } : {}) }];
    }
    if (same(base?.layoutSize, localNode?.layoutSize) && same(localNode?.layoutSize, remoteNode?.layoutSize)) {
      const node = mergeValue(base, localNode, remoteNode);
      return node ? [node] : [];
    }
    // Size measurements are display cache, not a competing edit of the workflow.
    const withoutSize = (node: (typeof before.nodes)[number] | undefined) => {
      if (!node) return node;
      const { layoutSize: _, ...definition } = node;
      return definition;
    };
    const node = mergeValue(withoutSize(base), withoutSize(localNode), withoutSize(remoteNode));
    const layoutSize = localNode?.layoutSize ?? remoteNode?.layoutSize;
    return node ? [{ ...node, ...(layoutSize ? { layoutSize } : {}) }] : [];
  });
  const names = [...new Set([...Object.keys(before.cardNames ?? {}), ...Object.keys(local.cardNames ?? {}), ...Object.keys(remote.cardNames ?? {})])];
  const cardNames = Object.fromEntries(names.flatMap(id => {
    const name = mergeValue(before.cardNames?.[id], local.cardNames?.[id], remote.cardNames?.[id]);
    return name === undefined ? [] : [[id, name]];
  }));
  const runs = [...new Set([...localRuns.keys(), ...remoteRuns.keys()])].flatMap(id => {
    const base = baseRuns.get(id), current = localRuns.get(id), external = remoteRuns.get(id), stale = staleSteps.get(id);
    if (stale && current && external && !staleLoopRuns.has(id)) {
      const steps = Object.fromEntries([...new Set([...Object.keys(current.steps), ...Object.keys(external.steps)])].flatMap(nodeId => {
        const previous = base?.steps[nodeId];
        const ours = current.steps[nodeId], theirs = external.steps[nodeId];
        const regressed = !theirs || theirs.status === "pending" && ours && ours.status !== "pending"
          || (ours?.status === "done" || ours?.status === "failed") && (theirs.status === "running" || theirs.status === "waiting");
        const step = mergeValue(previous, ours, stale.has(nodeId) || regressed ? previous : theirs);
        return step ? [[nodeId, step]] : [];
      }));
      return [{ ...current, steps }];
    }
    const run = mergeValue(base, current, stale ? base : external);
    return run ? [run] : [];
  });
  return { schema_version: 1, nodes, cardNames,
    run: runs[runs.length - 1] ?? null,
    ...(before.runs || local.runs || remote.runs ? { runs } : {}) };
}
