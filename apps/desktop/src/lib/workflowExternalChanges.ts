import { workflowRuns, type CanvasWorkflow } from "./canvasWorkflow";

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
function mergeValue<T>(before: T, local: T, remote: T): T {
  // Keep live execution objects when the native change only added/removed cards.
  if (same(remote, before) || same(local, remote)) return local;
  if (same(local, before)) return remote;
  throw new Error("同一卡片已有其他修改，请保留当前内容并重新打开项目后核对。");
}

/** Merge additions/removals from chat without dropping queued edits or execution state. */
export function mergeWorkflowChanges(before: CanvasWorkflow, local: CanvasWorkflow, remote: CanvasWorkflow): CanvasWorkflow {
  const baseNodes = new Map(before.nodes.map(node => [node.id, node]));
  const localNodes = new Map(local.nodes.map(node => [node.id, node]));
  const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
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
  const baseRuns = new Map(workflowRuns(before).map(run => [run.id, run]));
  const localRuns = new Map(workflowRuns(local).map(run => [run.id, run]));
  const remoteRuns = new Map(workflowRuns(remote).map(run => [run.id, run]));
  const runs = [...new Set([...localRuns.keys(), ...remoteRuns.keys()])].flatMap(id => {
    const run = mergeValue(baseRuns.get(id), localRuns.get(id), remoteRuns.get(id));
    return run ? [run] : [];
  });
  return { schema_version: 1, nodes, cardNames,
    run: runs[runs.length - 1] ?? null,
    ...(before.runs || local.runs || remote.runs ? { runs } : {}) };
}
