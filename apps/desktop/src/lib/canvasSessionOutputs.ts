import type { CanvasNode } from "./types";
import { canvasNoteValue, readCanvasNote, type CanvasNotePayload } from "./canvasNotes";
import { activePromptReferences, workflowActiveSession, workflowBindingKey, type WorkflowInput, type WorkflowNode } from "./canvasWorkflow";

function payload(node: CanvasNode) {
  try { return JSON.parse(node.payloadJson); } catch { return {}; }
}

/** Workflow sessions remain in execution history, but have no standalone canvas card. */
export function workflowSessionIds(workflow: readonly WorkflowNode[]) {
  return new Set(workflow.filter(node => node.kind === "generation")
    .flatMap(node => [...(node.sessionNodeIds ?? []), ...(node.activeSessionNodeId ? [node.activeSessionNodeId] : [])]));
}

/** A session socket refers to this exact turn, never later turns of the same job. */
export function canvasSessionImages(session: CanvasNode, nodes: readonly CanvasNode[]) {
  const turn = payload(session);
  if (session.kind !== "prompt" || !turn.job_id || !turn.turn_key) return [];
  return nodes.filter(node => {
    const execution = node.kind === "asset" && payload(node).execution;
    return node.assetId && node.projectId === session.projectId && execution?.job_id === turn.job_id && execution?.turn_key === turn.turn_key;
  });
}

export function canvasInputValue(source: CanvasNode, cellId: string, nodes: readonly CanvasNode[]) {
  if (source.kind === "prompt" && cellId === "image") {
    return { type: "image" as const, assetIds: [...new Set(canvasSessionImages(source, nodes).map(node => node.assetId!))] };
  }
  if (source.kind !== "note") return undefined;
  const note = resolveGenerationCells(readCanvasNote(source), nodes);
  const value = canvasNoteValue(note, cellId);
  if (value?.type !== "image") return value;
  const nodeIds = note.cells.flat().filter(cell => cellId === "*" || cell.id === cellId)
    .flatMap(cell => cell.generation_ref && !cell.image_refs?.length ? [cell.generation_ref.session_node_id] : []);
  return nodeIds.length ? { ...value, nodeIds: [...new Set(nodeIds)] } : value;
}

/** Source identity is independent of whether the source currently has a value. */
export function canvasWorkflowInputState(input: WorkflowInput, canvas: readonly CanvasNode[], workflow: WorkflowNode[]) {
  if (!input.canvasNodeId) return "ready";
  const source = canvas.find(node => node.id === input.canvasNodeId && node.hiddenAt == null);
  if (source) return canvasInputValue(source, input.cellId ?? "", canvas) === undefined ? "missing" : "ready";
  return workflow.some(node => node.resultNodeIds?.includes(input.canvasNodeId!)) ? "pending" : "missing";
}

/** Replace obsolete cell connections only with an explicitly connected, unambiguous live source. */
export function reconcileCanvasWorkflowReferences(nodes: WorkflowNode[], canvas: readonly CanvasNode[]) {
  return nodes.map(node => {
    if (node.kind !== "generation" && node.kind !== "agent") return node;
    // Source-based repair is only for legacy saves; numbered pipes never merge.
    if (Object.values(node.inputs).flat().some(input => input.slot !== undefined) || node.promptReferences?.some(ref => ref.slot !== undefined)) return node;
    const active = activePromptReferences(node);
    const replacements = new Map<string, WorkflowInput>();
    for (const type of ["text", "image"] as const) {
      const inputs = node.inputs[type] ?? [];
      const references = active.filter(ref => ref.type === type);
      const missing = [...new Map([...inputs, ...references.map(ref => ref.input)]
        .filter(input => input.canvasNodeId && canvasWorkflowInputState(input, canvas, nodes) === "missing")
        .map(input => [workflowBindingKey(input), input])).values()];
      for (const old of missing) {
        if (missing.filter(input => input.canvasNodeId === old.canvasNodeId).length !== 1) continue;
        const candidates = inputs.filter(input => input.canvasNodeId === old.canvasNodeId
          && canvasWorkflowInputState(input, canvas, nodes) === "ready"
          && !references.some(ref => workflowBindingKey(ref.input) === workflowBindingKey(input)));
        if (candidates.length === 1) replacements.set(`${type}:${workflowBindingKey(old)}`, candidates[0]);
      }
    }
    if (!replacements.size) return node;
    const replace = (type: string, input: WorkflowInput) => replacements.get(`${type}:${workflowBindingKey(input)}`) ?? input;
    return { ...node,
      inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) => [port,
        [...new Map(inputs.map(input => { const next = replace(port, input); return [workflowBindingKey(next), next]; })).values()]])),
      promptReferences: node.promptReferences?.map(ref => ({ ...ref, input: replace(ref.type, ref.input) })),
    };
  });
}

/** Keep execution records; only suppress duplicate standalone result presentations. */
export function containedSessionOutputIds(nodes: readonly CanvasNode[], workflow: readonly WorkflowNode[]) {
  const hidden = new Set<string>();
  const sessions = nodes.filter(node => node.kind === "prompt" && node.hiddenAt == null);
  for (const writer of workflow) {
    if (!writer.textTarget?.image) continue;
    const table = nodes.find(node => node.id === writer.textTarget!.nodeId && node.kind === "note" && node.hiddenAt == null);
    if (!table) continue;
    const note = readCanvasNote(table);
    if (note.note_type !== "images" && note.note_type !== "text") continue;
    const contained = new Set([writer.textTarget.cellId, ...(writer.textTarget.cellIds ?? [])].flatMap(id => canvasNoteValue(note, id)?.assetIds ?? []));
    for (const input of writer.inputs.image ?? []) {
      const generator = workflow.find(node => node.id === input.nodeId && node.kind === "generation");
      const sessionId = generator ? workflowActiveSession(generator) : input.canvasNodeId;
      // A retained picture in a container is not a live connection to its former session.
      for (const session of sessions.filter(session => session.id === sessionId || !!input.assetId)) {
        for (const output of canvasSessionImages(session, nodes)) {
          if (contained.has(output.assetId!) && (!input.assetId || output.assetId === input.assetId)
            && (!input.assetNodeId || output.id === input.assetNodeId)) hidden.add(output.id);
        }
      }
    }
  }
  return hidden;
}

/** Embedded generation is an exact saved turn, never a new model request. */
export function resolveGenerationCells(note: CanvasNotePayload, nodes: readonly CanvasNode[]): CanvasNotePayload {
  let changed = false;
  const cells = note.cells.map(row => row.map(cell => {
    const ref = cell.generation_ref;
    if (!ref || cell.content_type !== "image") return cell;
    const session = nodes.find(node => node.id === ref.session_node_id && node.kind === "prompt" && node.hiddenAt == null);
    if (!session || payload(session).status !== "done") return cell;
    const outputs = canvasSessionImages(session, nodes).filter(node => node.hiddenAt == null);
    const output = ref.output_node_id ? outputs.find(node => node.id === ref.output_node_id) : outputs[outputs.length - 1];
    if (!output?.assetId) return cell;
    if (cell.image_refs?.length === 1 && cell.image_refs[0].asset_id === output.assetId && ref.output_node_id === output.id) return cell;
    changed = true;
    return { ...cell, text: "@图片1", image_refs: [{ asset_id: output.assetId, token: "@图片1" }],
      generation_ref: { ...ref, output_node_id: output.id } };
  }));
  return changed ? { ...note, cells, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } : note;
}
