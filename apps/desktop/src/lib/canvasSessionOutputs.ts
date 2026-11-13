import type { CanvasNode } from "./types";
import { canvasConversationCards } from "./canvasConversationCards";
import { canvasDocumentTextValue, canvasNoteValue, readCanvasNote, type CanvasNotePayload } from "./canvasNotes";
import { contentInputAxisIndex } from "./canvasContentInput";
import { documentMediaReferences, type DocumentMediaReference } from "./documentProjection";
import { activePromptReferences, isWorkflowGenerationResult, workflowActiveSession, workflowBindingKey, type WorkflowInput, type WorkflowNode } from "./canvasWorkflow";

function payload(node: CanvasNode) {
  try { return JSON.parse(node.payloadJson); } catch { return {}; }
}

/** Completion follows the connected conversation, while image data stays tied to its exact turn. */
export function completedCanvasSessions(inputs: WorkflowInput[], nodes: readonly CanvasNode[], jobs: Parameters<typeof canvasConversationCards>[1]) {
  const conversations = canvasConversationCards(nodes, jobs);
  const sessions = inputs.flatMap(input => {
    if (!input.canvasNodeId || input.cellId !== "image") return [];
    const source = nodes.find(node => node.id === input.canvasNodeId && node.kind === "prompt" && node.hiddenAt == null);
    if (!source) return [];
    return conversations.cards.get(conversations.aliases.get(source.id) ?? source.id)?.sessions ?? [source];
  });
  return [...new Set(sessions.filter(session => payload(session).status === "done"
    && canvasSessionImages(session, nodes).some(output => output.hiddenAt == null)).map(session => session.id))];
}

/** All generation-card sessions, including those visible on the canvas. */
export function workflowSessionIds(workflow: readonly WorkflowNode[]) {
  return new Set(workflow.filter(node => node.kind === "generation")
    .flatMap(node => [...(node.sessionNodeIds ?? []), ...(node.activeSessionNodeId ? [node.activeSessionNodeId] : [])]));
}

/** Video cards retain their existing history-only presentation. */
export function hiddenWorkflowSessionIds(workflow: readonly WorkflowNode[]) {
  return workflowSessionIds(workflow.filter(node => node.generation?.media === "video"));
}

/** A connected content destination owns presentation before delivery and across reruns. */
export function contentRoutedWorkflowSessionIds(nodes: readonly CanvasNode[], workflow: readonly WorkflowNode[]) {
  const sources = new Set<string>();
  for (const writer of workflow) {
    const target = writer.textTarget;
    if (!target?.image) continue;
    const table = nodes.find(node => node.id === target.nodeId && node.kind === "note" && node.hiddenAt == null);
    if (!table) continue;
    const note = readCanvasNote(table);
    if (note.note_type !== "text" && note.note_type !== "images") continue;
    if (target.appendAxis ? contentInputAxisIndex(note, target) < 0 : !target.append && !note.cells.flat().some(cell => cell.id === target.cellId)) continue;
    for (const input of writer.inputs.image ?? []) if (input.nodeId && input.portId === "image") sources.add(input.nodeId);
  }
  return workflowSessionIds(workflow.filter(node => sources.has(node.id) && node.generation?.media !== "video"));
}

/** A session socket exposes only this turn's results, never its reference images or later turns. */
export function canvasSessionImages(session: CanvasNode, nodes: readonly CanvasNode[]) {
  const turn = payload(session);
  if (session.kind !== "prompt" || !turn.job_id || !turn.turn_key) return [];
  return nodes.filter(node => {
    const execution = node.kind === "asset" && node.role === "output" && payload(node).execution;
    return node.assetId && node.projectId === session.projectId && execution?.job_id === turn.job_id && execution?.turn_key === turn.turn_key;
  });
}

/** Match the runtime's exact-turn lookup, including its single latest image. */
export function latestWorkflowSessionImage(session: CanvasNode, nodes: readonly CanvasNode[]) {
  return canvasSessionImages(session, nodes).filter(output => output.hiddenAt == null).pop();
}

export function workflowGenerationPreviewIds(source: WorkflowNode, canvas: readonly CanvasNode[]) {
  const output = source.outputs.image;
  if (!output?.nodeIds?.length) return output?.assetIds ?? [];
  const sessionAssets = output.nodeIds.flatMap(id => {
    const session = canvas.find(card => card.id === id && card.kind === "prompt" && card.hiddenAt == null);
    const latest = session && payload(session).status === "done" ? latestWorkflowSessionImage(session, canvas) : undefined;
    return latest?.assetId ? [latest.assetId] : [];
  });
  return [...new Set([...(output.assetIds ?? []), ...sessionAssets])];
}

export function workflowBindingAssetIds(input: WorkflowInput, source: WorkflowNode | undefined, card: CanvasNode | undefined, canvas: readonly CanvasNode[]) {
  if (input.groupId) return input.assetIds ?? [];
  if (input.assetId) return [input.assetId];
  if (input.canvasNodeId) return card && card.hiddenAt == null ? canvasInputAssetIds(card, input.cellId ?? "", canvas) : [];
  if (source && isWorkflowGenerationResult(input, source)) return workflowGenerationPreviewIds(source, canvas);
  return source?.outputs[input.portId ?? ""]?.assetIds ?? [];
}

/** A direct workflow binding follows the producer; its visible wire follows this turn's card. */
export function workflowGenerationResultAnchor(source: WorkflowNode, canvas: readonly CanvasNode[], conversations?: ReturnType<typeof canvasConversationCards>) {
  const output = source.outputs.image;
  if (!output) return;
  const presented = (id: string): { nodeId: string; cellId?: string } | undefined => {
    const embedded = conversations?.embedded.get(id);
    if (embedded) return embedded;
    const anchor = conversations?.aliases.get(id) ?? id;
    return conversations?.hiddenIds.has(anchor) ? undefined : { nodeId: anchor };
  };
  if (source.kind === "comfy-video") {
    const card = canvas.find(card => source.resultNodeIds?.includes(card.id) && card.hiddenAt == null && card.assetId && output.assetIds?.includes(card.assetId));
    return card && presented(card.id);
  }
  if (source.kind !== "generation") return;
  const sessionId = output.nodeIds?.[0] ?? workflowActiveSession(source);
  const session = canvas.find(card => card.id === sessionId && card.kind === "prompt" && card.hiddenAt == null);
  if (!session) return;
  if (source.generation?.media !== "video" && !payload(session).generation_group_dissolved) return presented(session.id);
  const current = canvasSessionImages(session, canvas).filter(card => card.hiddenAt == null);
  const result = output.assetIds?.length ? current.find(card => output.assetIds!.includes(card.assetId!)) : current.pop();
  return result && presented(result.id);
}

type NoteInput = { json: string; note: CanvasNotePayload; media?: DocumentMediaReference[]; text?: ReturnType<typeof canvasDocumentTextValue> };
const noteInputs = new WeakMap<CanvasNode, NoteInput>();
function noteInput(source: CanvasNode): NoteInput {
  const saved = noteInputs.get(source);
  if (saved?.json === source.payloadJson) return saved;
  const next = { json: source.payloadJson, note: readCanvasNote(source) };
  noteInputs.set(source, next);
  return next;
}

/** A media lookup must not format a document's Markdown or build its full text output. */
export function canvasInputAssetIds(source: CanvasNode, port: string, nodes: readonly CanvasNode[]) {
  if (source.kind === "note") {
    const entry = noteInput(source);
    if (entry.note.note_type === "document") {
      if (port !== "*" && port !== "*text") return [];
      const refs = entry.media ??= documentMediaReferences(entry.note.text);
      return [...new Set(refs.filter(ref => port === "*text" || ref.kind === "image").map(ref => ref.assetId))];
    }
  }
  return canvasInputValue(source, port, nodes)?.assetIds ?? [];
}

export function canvasInputValue(source: CanvasNode, cellId: string, nodes: readonly CanvasNode[]) {
  if (source.kind === "prompt" && cellId === "image") {
    const { status } = payload(source);
    const outputs = source.hiddenAt == null && (!status || status === "done")
      ? canvasSessionImages(source, nodes).filter(node => node.hiddenAt == null) : [];
    return { type: "image" as const, assetIds: [...new Set(outputs.map(node => node.assetId!))] };
  }
  if (source.kind !== "note") return undefined;
  const entry = noteInput(source);
  if (entry.note.note_type === "document" && cellId === "*text") {
    const value = entry.text ??= canvasDocumentTextValue(entry.note.text);
    return { ...value, assetIds: [...value.assetIds], imageRefs: value.imageRefs.map(ref => ({ ...ref })) };
  }
  const note = resolveGenerationCells(entry.note, nodes);
  const value = canvasNoteValue(note, cellId);
  if (!value || value.type !== "image" && cellId !== "*latest") return value;
  const latest = cellId === "*latest" || cellId === "*latest-image";
  const nodeIds = (latest ? note.cells.slice(-1) : note.cells).flat().filter(cell => latest || cellId === "*" || cell.id === cellId)
    .flatMap(cell => cell.generation_ref && !cell.image_refs?.length ? [cell.generation_ref.session_node_id] : []);
  return nodeIds.length ? { ...value, nodeIds: [...new Set(nodeIds)] } : value;
}

/** Source identity is independent of whether the source currently has a value. */
export function canvasWorkflowInputState(input: WorkflowInput, canvas: readonly CanvasNode[], workflow: WorkflowNode[]) {
  if (!input.canvasNodeId) return "ready";
  const source = canvas.find(node => node.id === input.canvasNodeId && node.hiddenAt == null);
  if (source) {
    const port = input.cellId ?? "";
    if (source.kind === "prompt") return port === "image" ? "ready" : "missing";
    if (source.kind !== "note") return "missing";
    const { note } = noteInput(source);
    if (note.note_type === "document") return port === "*" || port === "*text" ? "ready" : "missing";
    return ["*", "*text", "*latest", "*latest-image"].includes(port) || note.cells.some(row => row.some(cell => cell.id === port)) ? "ready" : "missing";
  }
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
