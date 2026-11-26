import type { CanvasNode, GenJob } from "./types";
import { canvasNodePayload as payload, canvasOutputIsVideo } from "./canvasNodePayload.ts";
import { canvasConversationCards } from "./canvasConversationCards";
import { canvasDocumentTextValue, canvasNoteValue, readCanvasNote, type CanvasNotePayload } from "./canvasNotes";
import { contentInputAxisIndex } from "./canvasContentInput";
import { documentMediaReferences, type DocumentMediaReference } from "./documentProjection";
import { generationPromptNodeId } from "./projectNodeIds";
import { activePromptReferences, isWorkflowGenerationResult, workflowActiveSession, workflowBindingKey, workflowInputAssetId, workflowInputProducers,
  workflowRunActive, workflowRuns, type CanvasWorkflow, type WorkflowInput, type WorkflowNode, type WorkflowRun } from "./canvasWorkflow";

interface CanvasSnapshotIndex {
  byId: Map<string, CanvasNode>;
  order: Map<string, number>;
  visibleSessions: Map<string, CanvasNode>;
  outputsByTurn?: Map<string, CanvasNode[]>;
  sessionOutputsByAsset?: Map<string, CanvasNode[]>;
  resolvedNotes?: WeakMap<CanvasNotePayload, CanvasNotePayload>;
}

const snapshotIndexes = new WeakMap<readonly CanvasNode[], CanvasSnapshotIndex>();
function getCanvasSnapshotIndex(nodes: readonly CanvasNode[]): CanvasSnapshotIndex {
  const cached = snapshotIndexes.get(nodes);
  if (cached) return cached;
  const index: CanvasSnapshotIndex = { byId: new Map(), order: new Map(), visibleSessions: new Map() };
  nodes.forEach((node, position) => {
    if (index.byId.has(node.id)) return;
    index.byId.set(node.id, node);
    index.order.set(node.id, position);
    if (node.kind === "prompt" && node.hiddenAt == null) index.visibleSessions.set(node.id, node);
  });
  snapshotIndexes.set(nodes, index);
  return index;
}

/** Result of the exact submitted turn, independent of other turns in its gallery. */
export function submittedTurnState(id: string, nodes: readonly CanvasNode[]): "pending" | "done" | "closed" {
  const turn = getCanvasSnapshotIndex(nodes).visibleSessions.get(id);
  if (!turn) return "closed";
  const status = payload(turn).status;
  if (status && ["failed", "cancelled", "canceled", "stopped"].includes(status)) return "closed";
  return canvasSessionCompleted(turn, nodes) ? "done" : "pending";
}

export function canvasSessionCompleted(session: CanvasNode, nodes: readonly CanvasNode[]) {
  return payload(session).status === "done" && canvasSessionImages(session, nodes).some(output => output.hiddenAt == null);
}

/** Completion follows the connected conversation, while image data stays tied to its exact turn. */
export function completedCanvasSessions(inputs: WorkflowInput[], nodes: readonly CanvasNode[], jobs: Parameters<typeof canvasConversationCards>[1]) {
  return canvasSessionCompletionLookup(nodes, jobs)(inputs);
}

export function canvasSessionCompletionLookup(nodes: readonly CanvasNode[], jobs: Parameters<typeof canvasConversationCards>[1]) {
  const status = canvasSessionCompletionStatus(nodes, jobs);
  return (inputs: WorkflowInput[]) => status(inputs).completed;
}

export function canvasSessionCompletionStatus(nodes: readonly CanvasNode[], jobs: Parameters<typeof canvasConversationCards>[1]) {
  const sessionsById = getCanvasSnapshotIndex(nodes).visibleSessions;
  let conversations: ReturnType<typeof canvasConversationCards> | undefined;
  return (inputs: WorkflowInput[]) => {
    const sessions = inputs.flatMap(input => {
      if (input.pendingCompletionSession) {
        const turn = sessionsById.get(input.pendingCompletionSession);
        return turn ? [turn] : [];
      }
      if (!input.canvasNodeId || input.cellId !== "image") return [];
      const source = sessionsById.get(input.canvasNodeId);
      if (!source) return [];
      conversations ??= canvasConversationCards(nodes, jobs);
      return conversations.cards.get(conversations.aliases.get(source.id) ?? source.id)?.sessions ?? [source];
    });
    const completed = new Set<string>();
    let pending = false;
    for (const session of sessions) {
      const phase = payload(session).status;
      if (phase === "done") {
        const outputs = canvasSessionImages(session, nodes);
        if (outputs.some(output => output.hiddenAt == null)) completed.add(session.id);
        else if (!outputs.length) pending = true; // The terminal signal may precede delivery.
      } else if (pendingGeneration(phase)) pending = true;
    }
    return { completed: [...completed], pending };
  };
}

/** All generation-card sessions, including those visible on the canvas. */
export function workflowSessionIds(workflow: readonly WorkflowNode[]) {
  return new Set(workflow.filter(node => node.kind === "generation" || node.kind === "comfy-video")
    .flatMap(node => [...(node.sessionNodeIds ?? []), ...(node.activeSessionNodeId ? [node.activeSessionNodeId] : [])]));
}

const collapsibleGenerationCard = (node: WorkflowNode) => node.kind === "generation" || node.kind === "comfy-video";
const videoGenerationCard = (node: WorkflowNode) => node.kind === "comfy-video" || node.generation?.media === "video";
const ordinaryImageCard = (node: WorkflowNode) => node.kind === "generation" && !videoGenerationCard(node);
const pendingGeneration = (status: unknown) => status === "running" || status === "querying" || status === "queued";
const workflowMediaOutput = (node: CanvasNode) => node.kind === "asset" && node.role === "output" && !!node.assetId;
const generationSessions = (node: WorkflowNode) => [...(node.sessionNodeIds ?? []), ...(node.outputs.image?.nodeIds ?? []), workflowActiveSession(node)];

export interface WorkflowGenerationActivity {
  running: boolean;
  holdingPlacement?: boolean;
  attemptId?: string;
  terminal?: "done" | "failed" | "cancelled";
  awaitingOutput?: boolean;
  jobId?: string;
  failed?: boolean;
  session?: CanvasNode;
  sessionStatus?: string;
  error?: string;
}

/** A step hands off generation before the exact turn and its output reach the board. */
export function workflowGenerationActivity(node: WorkflowNode, run: WorkflowRun | undefined,
  nodes: readonly CanvasNode[], jobs: Readonly<Record<string, GenJob>>, displayable?: ReadonlySet<string>): WorkflowGenerationActivity {
  if (!collapsibleGenerationCard(node)) return { running: false };
  const step = run?.steps[node.id];
  const submitted = step?.generationSubmission === "submitted";
  const executing = !!run && workflowRunActive(run) && step?.status === "running";
  if (step?.comfyOptimization && !step.comfyAutoGeneration) return { running: executing };
  const canvasNodes = getCanvasSnapshotIndex(nodes).byId;
  const sessionId = workflowActiveSession(node);
  const checkpointId = step?.jobId && step.turnKey ? generationPromptNodeId(step.jobId, step.turnKey) : undefined;
  const exactSession = checkpointId ? canvasNodes.get(checkpointId) : undefined;
  const savedSession = sessionId ? canvasNodes.get(sessionId) : undefined;
  const session = exactSession?.kind === "prompt" ? exactSession : savedSession?.kind === "prompt"
    && (!checkpointId || payload(savedSession).job_id === step?.jobId && payload(savedSession).turn_key === step?.turnKey) ? savedSession : undefined;
  const data = session && payload(session);
  const jobId = step?.jobId ?? data?.job_id;
  const turnKey = step?.turnKey ?? data?.turn_key;
  const job = jobId ? jobs[jobId] : undefined;
  const turn = turnKey ? job?.turns.find(turn => turn.turnKey === turnKey) : undefined;
  const live = !!turn && !!job?.running && job.turns[job.turns.length - 1] === turn;
  const sessionStatus = data?.status;
  const error = !live ? turn?.error ?? step?.error : undefined;
  const cancelled = ["cancelled", "canceled", "stopped"].includes(sessionStatus ?? "") || step?.comfyCancelled
    || run?.status === "stopped" && !submitted && !live;
  const failed = !cancelled && (sessionStatus === "failed" || step?.status === "failed" || !!turn?.error && !live);
  const completed = sessionStatus === "done" || !live && !!turn?.images?.length || videoGenerationCard(node) && step?.status === "done";
  const attemptId = step && run ? run.loop?.bodyIds.includes(node.id) ? `${run.id}:${run.loop.index}` : run.id
    : session?.id ?? sessionId ?? undefined;
  const comfyOutput = node.kind === "comfy-video" && jobId ? canvasNodes.get(`workflow-comfy:${jobId}`) : undefined;
  const outputs = !completed ? [] : node.kind === "comfy-video"
    ? comfyOutput?.kind === "asset" && comfyOutput.role === "output" ? [comfyOutput] : []
    : canvasTurnOutputs(nodes, session?.projectId ?? job?.projectId ?? nodes[0]?.projectId, jobId, turnKey);
  const availableOutputs = outputs.filter(output => output.assetId && output.hiddenAt == null);
  const hasVisibleOutput = availableOutputs.some(output => !displayable || displayable.has(output.id));
  const terminal = cancelled ? "cancelled" : failed ? "failed" : completed && hasVisibleOutput ? "done" : undefined;
  const awaitingOutput = !!completed && !hasVisibleOutput && (!outputs.length || !!availableOutputs.length);
  const running = !terminal && (executing || !completed && (live || pendingGeneration(sessionStatus)
    || submitted && !!checkpointId || videoGenerationCard(node) && step?.status === "waiting" && !!step.videoJobActive));
  return { running, attemptId, terminal, awaitingOutput, jobId, failed, session, sessionStatus, error };
}

/** Exact saved result IDs and turn identities establish provenance, never Asset ID equality. */
function generationOrigins(workflow: readonly WorkflowNode[], nodes: readonly CanvasNode[], runs: ReturnType<typeof workflowRuns> = []) {
  const sources = new Map(workflow.map(node => [node.id, node]));
  const direct = new Map<string, WorkflowNode | null>(), jobs = new Map<string, WorkflowNode | null>();
  const turns = new Map<string, WorkflowNode | null>();
  const delivered = new Map<string, WorkflowNode | null>();
  const key = (projectId: string, jobId: string, turnKey?: string) => JSON.stringify([projectId, jobId, turnKey]);
  function record(index: Map<string, WorkflowNode | null>, id: string, source: WorkflowNode) {
    index.set(id, index.has(id) && index.get(id) !== source ? null : source);
  }
  for (const source of sources.values()) {
    for (const id of generationSessions(source)) if (id) record(direct, id, source);
    for (const id of source.resultNodeIds ?? []) record(direct, id, source);
  }
  for (const run of runs) for (const [id, step] of Object.entries(run.steps)) {
    const source = sources.get(id);
    if (!source) continue;
    if (step.jobId) {
      record(jobs, step.jobId, source);
      if (source.kind === "comfy-video") record(delivered, `workflow-comfy:${step.jobId}`, source);
    }
    if (videoGenerationCard(source) && step.localDsRequestId) record(delivered, `workflow-video:${step.localDsRequestId}`, source);
  }
  const origins = new Map<string, WorkflowNode>();
  function owner(node: CanvasNode, data: ReturnType<typeof payload>): WorkflowNode | undefined {
    const group: unknown = data.workflow_generation_group;
    if (direct.has(node.id)) {
      const source = direct.get(node.id);
      if (!source || data.workflow_source && data.workflow_source !== source.id
        || typeof group === "string" && group.startsWith("workflow:") && group !== `workflow:${JSON.stringify([node.projectId, source.id])}`) return;
      return source;
    }
    if (typeof group === "string" && group.startsWith("workflow:")) {
      try {
        const [project, id] = JSON.parse(group.slice("workflow:".length));
        return project === node.projectId && (!data.workflow_source || data.workflow_source === id) ? sources.get(id) : undefined;
      } catch { return; }
    }
    if (canvasOutputIsVideo(node)) return data.workflow_source ? sources.get(data.workflow_source) : delivered.get(node.id) ?? undefined;
  }
  for (const node of nodes) {
    if (node.kind !== "prompt") continue;
    const data = payload(node);
    const source = owner(node, data) ?? (!direct.has(node.id) && data.job_id ? jobs.get(data.job_id) : undefined);
    if (!source || !data.job_id) continue;
    if (data.turn_key) record(turns, key(node.projectId, data.job_id, data.turn_key), source);
    if (node.hiddenAt == null) origins.set(node.id, source);
  }
  for (const node of nodes) {
    if (node.hiddenAt != null || !workflowMediaOutput(node)) continue;
    const data = payload(node), execution = data.execution;
    const resolved = owner(node, data);
    const exactTurn = execution?.job_id && execution?.turn_key ? key(node.projectId, execution.job_id, execution.turn_key) : undefined;
    const source = exactTurn
      ? (turns.has(exactTurn) ? turns.get(exactTurn) : resolved)
      : resolved && (data.workflow_generation_group === `workflow:${JSON.stringify([node.projectId, resolved.id])}`
        || data.workflow_source === resolved.id || delivered.get(node.id) === resolved
        || resolved.outputs.image?.assetIds?.includes(node.assetId!)) ? resolved : undefined;
    // Old native output payloads need not include a file extension in snapshot.name.
    const video = node.outputIsVideo ?? (canvasOutputIsVideo(node) || !!source && videoGenerationCard(source) && node.id.startsWith("gen-output:"));
    if (source && video === videoGenerationCard(source) && (!resolved || source === resolved)
      && (!direct.has(node.id) || direct.get(node.id) === source)) {
      origins.set(node.id, source);
    }
  }
  return origins;
}

/** Video cards retain history-only presentation. Do not show an extra placeholder for a first image run. */
export function hiddenWorkflowSessionIds(workflow: readonly WorkflowNode[], nodes: readonly CanvasNode[] = [],
  jobs: Readonly<Record<string, GenJob>> = {}) {
  const hidden = workflowSessionIds(workflow.filter(videoGenerationCard));
  if (!nodes.length) return hidden;
  const owned = workflowSessionIds(workflow);
  for (const node of nodes) {
    if (node.kind !== "prompt" || !owned.has(node.id)) continue;
    const delivered = canvasSessionImages(node, nodes);
    if (delivered.some(canvasOutputIsVideo)) hidden.add(node.id);
    else if (delivered.some(output => output.outputIsVideo === false)) hidden.delete(node.id);
  }
  const imageCards = workflow.filter(ordinaryImageCard);
  const origins = generationOrigins(imageCards, nodes);
  const hasOutput = new Set(nodes.filter(workflowMediaOutput).map(node => origins.get(node.id)?.id));
  for (const source of imageCards) {
    const active = workflowActiveSession(source);
    if (!active || hasOutput.has(source.id)) continue;
    const activity = workflowGenerationActivity(source, undefined, nodes, jobs);
    if (activity.running || activity.failed) hidden.add(active);
  }
  return hidden;
}

/** A connected content destination owns presentation before delivery and across reruns. */
function contentRoutedWorkflowSourceIds(nodes: readonly CanvasNode[], workflow: readonly WorkflowNode[]) {
  const sources = new Set<string>();
  const { byId } = getCanvasSnapshotIndex(nodes);
  for (const writer of workflow) {
    const target = writer.textTarget;
    if (!target?.image) continue;
    const table = byId.get(target.nodeId);
    if (table?.kind !== "note" || table.hiddenAt != null) continue;
    const note = noteInput(table).note;
    if (note.note_type !== "text" && note.note_type !== "images") continue;
    if (target.appendAxis ? contentInputAxisIndex(note, target) < 0 : !target.append && !note.cells.flat().some(cell => cell.id === target.cellId)) continue;
    for (const input of writer.inputs.image ?? []) if (input.nodeId && input.portId === "image") sources.add(input.nodeId);
  }
  return sources;
}

export function contentRoutedWorkflowSessionIds(nodes: readonly CanvasNode[], workflow: readonly WorkflowNode[]) {
  const sources = contentRoutedWorkflowSourceIds(nodes, workflow);
  return workflowSessionIds(workflow.filter(node => sources.has(node.id) && node.generation?.media !== "video"));
}

/** Exact generation ownership is also used when a collapsed result serves as a connection target. */
export function workflowGenerationOrigins(document: CanvasWorkflow, nodes: readonly CanvasNode[]) {
  return generationOrigins(document.nodes.filter(collapsibleGenerationCard), nodes, workflowRuns(document));
}

/** Compute the current projected media without mutating workflow or generation history. */
export function workflowGenerationCardProjection(document: CanvasWorkflow, nodes: readonly CanvasNode[],
  conversations: ReturnType<typeof canvasConversationCards>, unavailable: ReadonlySet<string> = new Set()) {
  const origins = workflowGenerationOrigins(document, nodes);
  const exempt = contentRoutedWorkflowSourceIds(nodes, document.nodes);
  const descendants = new Set(document.nodes.filter(node => node.kind === "loop" || node.kind === "trigger").map(node => node.id));
  if (descendants.size) {
    const followers = new Map<string, Set<string>>();
    for (const node of document.nodes) for (const input of Object.values(node.inputs).flat()) {
      for (const id of workflowInputProducers(document.nodes, input)) {
        const targets = followers.get(id) ?? new Set<string>();
        targets.add(node.id);
        followers.set(id, targets);
      }
    }
    for (const id of descendants) for (const child of followers.get(id) ?? []) descendants.add(child);
  }
  for (const id of descendants) exempt.add(id);
  for (const run of workflowRuns(document)) if (workflowRunActive(run)) for (const id of run.loop?.bodyIds ?? []) exempt.add(id);
  for (const trigger of document.nodes.filter(node => node.kind === "trigger")) for (const input of Object.values(trigger.inputs).flat()) {
    const source = input.nodeId ?? origins.get(input.canvasNodeId ?? input.pendingCompletionSession ?? "")?.id;
    if (source) exempt.add(source);
  }

  const visible = new Map(nodes.filter(node => node.hiddenAt == null && !conversations.hiddenIds.has(node.id)
    && !unavailable.has(node.id)).map(node => [node.id, node]));
  const candidates = new Map<string, Map<string, CanvasNode>>();
  for (const node of nodes) {
    const source = origins.get(node.id);
    if (!source || exempt.has(source.id) || unavailable.has(node.id) || !workflowMediaOutput(node)) continue;
    const anchor = visible.get(conversations.aliases.get(node.id) ?? node.id);
    if (!anchor) continue;
    const gallery = conversations.cards.get(anchor.id);
    if (gallery && gallery.outputs.some(output => origins.get(output.id) !== source)) continue;
    const owned = candidates.get(source.id) ?? new Map<string, CanvasNode>();
    owned.set(anchor.id, anchor);
    candidates.set(source.id, owned);
  }
  const anchors = new Map<string, CanvasNode>();
  for (const source of document.nodes) {
    const owned = candidates.get(source.id);
    if (!owned) continue;
    const preferred = workflowGenerationResultAnchor(source, nodes, conversations)?.nodeId;
    const anchor = (preferred && owned.get(preferred))
      || [...owned.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
    if (anchor) anchors.set(source.id, anchor);
  }
  return { anchors, origins, exempt };
}

function sessionOutputKey(projectId: string, jobId: unknown, turnKey: unknown) {
  if (!jobId || !turnKey || typeof jobId === "object" || typeof turnKey === "object") return undefined;
  return JSON.stringify([projectId, jobId, turnKey]);
}

/** A session socket exposes only this turn's results, never its reference images or later turns. */
export function canvasSessionImages(session: CanvasNode, nodes: readonly CanvasNode[]) {
  if (session.kind !== "prompt") return [];
  const turn = payload(session);
  return canvasTurnOutputs(nodes, session.projectId, turn.job_id, turn.turn_key).filter(node => node.assetId);
}

function canvasTurnOutputs(nodes: readonly CanvasNode[], projectId: string | undefined, jobId: unknown, turnKey: unknown) {
  const key = projectId && sessionOutputKey(projectId, jobId, turnKey);
  if (!key) return [];
  const index = getCanvasSnapshotIndex(nodes);
  let outputs = index.outputsByTurn;
  if (!outputs) {
    outputs = new Map();
    for (const node of nodes) {
      if (node.kind !== "asset" || node.role !== "output") continue;
      const execution = payload(node).execution;
      const owner = sessionOutputKey(node.projectId, execution?.job_id, execution?.turn_key);
      if (!owner) continue;
      const candidates = outputs.get(owner);
      if (candidates) candidates.push(node);
      else outputs.set(owner, [node]);
    }
    index.outputsByTurn = outputs;
  }
  return outputs.get(key)?.slice() ?? [];
}

/** Match the runtime's exact-turn lookup, including its single latest image. */
export function latestWorkflowSessionImage(session: CanvasNode, nodes: readonly CanvasNode[]) {
  return canvasSessionImages(session, nodes).filter(output => output.hiddenAt == null).pop();
}

export function workflowGenerationPreviewIds(source: WorkflowNode, canvas: readonly CanvasNode[]) {
  const output = source.outputs.image;
  if (!output?.nodeIds?.length) return output?.assetIds ?? [];
  const { visibleSessions } = getCanvasSnapshotIndex(canvas);
  const sessionAssets = output.nodeIds.flatMap(id => {
    const session = visibleSessions.get(id);
    const latest = session && payload(session).status === "done" ? latestWorkflowSessionImage(session, canvas) : undefined;
    return latest?.assetId ? [latest.assetId] : [];
  });
  return [...new Set([...(output.assetIds ?? []), ...sessionAssets])];
}

export function workflowBindingAssetIds(input: WorkflowInput, source: WorkflowNode | undefined, card: CanvasNode | undefined, canvas: readonly CanvasNode[]) {
  if (input.nodeId && (input.videoFrame || input.videoAudio)) return [];
  if (input.groupId) return input.assetIds ?? [];
  if (input.dimension) return [];
  const assetId = workflowInputAssetId(input);
  if (assetId) return [assetId];
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
  if (source.kind !== "generation" && source.kind !== "comfy-video") return;
  const index = getCanvasSnapshotIndex(canvas);
  const sessionId = output.nodeIds?.[0] ?? workflowActiveSession(source);
  const session = sessionId ? index.visibleSessions.get(sessionId) : undefined;
  const video = videoGenerationCard(source);
  const sameMedia = (card: CanvasNode) => card.outputIsVideo == null ? (video || !canvasOutputIsVideo(card)) : card.outputIsVideo === video;
  const delivered = session ? canvasSessionImages(session, canvas).filter(card => card.hiddenAt == null) : [];
  const current = delivered.filter(sameMedia);
  if (session && !video && !payload(session).generation_group_dissolved && (!delivered.length || current.length)) return presented(session.id);
  const assets = new Set(output.assetIds ?? []);
  let result = assets.size ? current.find(card => card.assetId && assets.has(card.assetId)) : current.pop();
  if (!result && assets.size) for (const id of source.resultNodeIds ?? []) {
    const card = index.byId.get(id);
    if (card && card.hiddenAt == null && card.assetId && assets.has(card.assetId) && sameMedia(card)
      && (!result || index.order.get(id)! < index.order.get(result.id)!)) result = card;
  }
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
  const index = getCanvasSnapshotIndex(nodes), workflowById = new Map(workflow.map(node => [node.id, node]));
  const outputsForAsset = (assetId: string) => {
    if (!index.sessionOutputsByAsset) {
      const grouped = new Map<string, CanvasNode[]>();
      for (const session of index.visibleSessions.values()) for (const output of canvasSessionImages(session, nodes)) {
        if (!output.assetId) continue;
        const entries = grouped.get(output.assetId) ?? [];
        entries.push(output);
        grouped.set(output.assetId, entries);
      }
      index.sessionOutputsByAsset = grouped;
    }
    return index.sessionOutputsByAsset.get(assetId) ?? [];
  };
  for (const writer of workflow) {
    if (!writer.textTarget?.image) continue;
    const table = index.byId.get(writer.textTarget.nodeId);
    if (table?.kind !== "note" || table.hiddenAt != null) continue;
    const note = noteInput(table).note;
    if (note.note_type !== "images" && note.note_type !== "text") continue;
    const contained = new Set([writer.textTarget.cellId, ...(writer.textTarget.cellIds ?? [])].flatMap(id => canvasNoteValue(note, id)?.assetIds ?? []));
    for (const input of writer.inputs.image ?? []) {
      const generator = input.nodeId ? workflowById.get(input.nodeId) : undefined;
      const sessionId = generator?.kind === "generation" ? workflowActiveSession(generator) : input.canvasNodeId;
      const session = sessionId ? index.visibleSessions.get(sessionId) : undefined;
      // A retained picture in a container is not a live connection to its former session.
      const outputs = input.assetId ? outputsForAsset(input.assetId) : session ? canvasSessionImages(session, nodes) : [];
      for (const output of outputs) {
        if (contained.has(output.assetId!) && (!input.assetNodeId || output.id === input.assetNodeId)) hidden.add(output.id);
      }
    }
  }
  return hidden;
}

/** Embedded generation is an exact saved turn, never a new model request. */
export function resolveGenerationCells(note: CanvasNotePayload, nodes: readonly CanvasNode[]): CanvasNotePayload {
  const index = getCanvasSnapshotIndex(nodes);
  const notes = index.resolvedNotes ??= new WeakMap();
  const cached = notes.get(note);
  if (cached) return cached;
  let changed = false;
  const cells = note.cells.map(row => row.map(cell => {
    const ref = cell.generation_ref;
    if (!ref || cell.content_type !== "image") return cell;
    const session = index.visibleSessions.get(ref.session_node_id);
    if (!session || payload(session).status !== "done") return cell;
    const outputs = canvasSessionImages(session, nodes).filter(node => node.hiddenAt == null);
    const output = ref.output_node_id ? outputs.find(node => node.id === ref.output_node_id) : outputs[outputs.length - 1];
    if (!output?.assetId) return cell;
    if (cell.image_refs?.length === 1 && cell.image_refs[0].asset_id === output.assetId && ref.output_node_id === output.id) return cell;
    changed = true;
    return { ...cell, text: "@图片1", image_refs: [{ asset_id: output.assetId, token: "@图片1" }],
      generation_ref: { ...ref, output_node_id: output.id } };
  }));
  const resolved = changed ? { ...note, cells, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n") } : note;
  notes.set(note, resolved);
  return resolved;
}
