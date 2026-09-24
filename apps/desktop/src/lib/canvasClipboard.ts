import type { CanvasNode, CanvasGroup, CanvasGroupItem, NewCanvasNode, NewCanvasGroup } from "./types";
import type { WorkflowInput, WorkflowNode } from "./canvasWorkflow";
import { expandCanvasSections, readCanvasNote } from "./canvasNotes";

const PREFIX = "BOWERBIRD_CANVAS_V1\n";
export interface CanvasClipboard {
  projectId: string;
  nodes: CanvasNode[];
  groups: CanvasGroup[];
  items: CanvasGroupItem[];
  workflow: WorkflowNode[];
  selection: string[];
}
export function captureCanvasClipboard(projectId: string, selected: Set<string>, nodes: CanvasNode[], groups: CanvasGroup[], items: CanvasGroupItem[], workflow: WorkflowNode[]): CanvasClipboard {
  const ids = expandCanvasSections(new Set(selected), nodes);
  for (const item of items) if (ids.has(item.groupId)) ids.add(item.nodeId);
  const copied = nodes.filter(node => ids.has(node.id) && node.hiddenAt == null && (node.kind === "asset" || node.kind === "note"));
  const nativeIds = new Set(copied.map(node => node.id));
  const cards = workflow.filter(node => node.kind === "text"
    ? nativeIds.has(node.textSource ?? node.textTarget?.nodeId ?? "") : ids.has(node.id));
  const copiedGroups = groups.filter(group => ids.has(group.id));
  const visible = new Set([...copied, ...copiedGroups, ...cards.filter(node => node.kind !== "text")].map(node => node.id));
  return structuredClone({ projectId, nodes: copied, groups: copiedGroups,
    items: items.filter(item => copiedGroups.some(group => group.id === item.groupId) && nativeIds.has(item.nodeId)), workflow: cards,
    selection: [...visible].filter(id => !items.some(item => item.nodeId === id && visible.has(item.groupId))) });
}
export const serializeCanvasClipboard = (value: CanvasClipboard) => PREFIX + JSON.stringify(value);
export function parseCanvasClipboard(text: string): CanvasClipboard | null {
  const prefix = /^BOWERBIRD_CANVAS_V1\r?\n/.exec(text);
  if (!prefix || text.length > 10_000_000) return null;
  try {
    const value = JSON.parse(text.slice(prefix[0].length)) as CanvasClipboard;
    if (typeof value.projectId !== "string" || ![value.nodes, value.groups, value.items, value.workflow, value.selection].every(Array.isArray)
      || value.workflow.length > 500 || !value.nodes.every(node => node.kind === "asset" || node.kind === "note")) return null;
    return value;
  } catch { return null; }
}

export function cloneCanvasClipboard(value: CanvasClipboard, projectId: string, x: number, y: number) {
  const cards = [...value.nodes, ...value.groups, ...value.workflow.filter(node => node.kind !== "text")];
  const dx = x - Math.min(...cards.map(node => node.x)), dy = y - Math.min(...cards.map(node => node.y));
  const ids = new Map([...cards, ...value.workflow].map(node => [node.id, crypto.randomUUID()]));
  const sameProject = projectId === value.projectId;
  const remap = (input: WorkflowInput): WorkflowInput | null => {
    const next = { ...input };
    for (const key of ["nodeId", "canvasNodeId", "assetNodeId", "groupId"] as const) {
      const old = input[key]; if (!old) continue;
      const id = ids.get(old);
      if (id) next[key] = id;
      else if (!sameProject || input.portId === "signal") {
        if (key === "assetNodeId") delete next.assetNodeId;
        else return null;
      }
    }
    return next;
  };
  const nodes: NewCanvasNode[] = value.nodes.map(node => {
    let payloadJson = node.payloadJson;
    if (node.kind === "note") {
      const note = readCanvasNote(node);
      payloadJson = JSON.stringify({ ...note, member_ids: note.member_ids.flatMap(id => ids.has(id) ? [ids.get(id)!] : []) });
    } else {
      const payload = JSON.parse(payloadJson);
      delete payload.execution;
      payloadJson = JSON.stringify(payload);
    }
    return { id: ids.get(node.id)!, projectId, threadId: null, kind: node.kind, assetId: node.assetId,
      role: node.kind === "asset" ? "reference" : null, payloadJson, x: node.x + dx, y: node.y + dy,
      width: node.width, height: node.height, zIndex: node.zIndex, positionLocked: node.positionLocked };
  });
  const groups: NewCanvasGroup[] = value.groups.map(({ createdAt: _c, updatedAt: _u, ...group }) => ({ ...group, id: ids.get(group.id)!, projectId, x: group.x + dx, y: group.y + dy }));
  const workflow = value.workflow.map(node => ({ ...structuredClone(node), id: ids.get(node.id)!, x: node.x + dx, y: node.y + dy,
    outputs: {}, outputPorts: [], activeSessionNodeId: null, sessionNodeIds: [], resultGroupId: undefined, profileCache: undefined, planning: undefined, templateInstance: undefined,
    resultNodeIds: node.resultNodeIds?.flatMap(id => ids.has(id) ? [ids.get(id)!] : []) ?? [],
    textSource: node.textSource ? ids.get(node.textSource) : undefined,
    textTarget: node.textTarget ? { ...node.textTarget, nodeId: ids.get(node.textTarget.nodeId)! } : undefined,
    inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) => [port, inputs.flatMap(input => { const next = remap(input); return next ? [next] : []; })])),
    promptReferences: node.promptReferences?.map(ref => ({ ...ref, input: remap(ref.input) ?? ref.input })),
  }));
  // Writers without their input (e.g. external sources on another project) remain plain content cells.
  const retained = workflow.filter(node => node.kind !== "text" || node.textSource || Object.values(node.inputs).flat().length);
  return { nodes, groups, workflow: retained, items: value.items.map(item => ({ ...item, projectId, groupId: ids.get(item.groupId)!, nodeId: ids.get(item.nodeId)! })),
    selection: value.selection.flatMap(id => ids.has(id) ? [ids.get(id)!] : []),
    width: Math.max(...cards.map(node => node.x + ("width" in node ? node.width : 320))) - Math.min(...cards.map(node => node.x)),
    height: Math.max(...cards.map(node => node.y + ("height" in node ? node.height : 400))) - Math.min(...cards.map(node => node.y)) };
}
