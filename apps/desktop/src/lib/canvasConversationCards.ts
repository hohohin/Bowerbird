import { readCanvasNote } from "./canvasNotes.ts";
import type { CanvasNode, GenJob } from "./types";

function payload(node: CanvasNode) {
  try { return JSON.parse(node.payloadJson); } catch { return {}; }
}

export interface CanvasConversationCard {
  anchor: CanvasNode;
  latest: CanvasNode;
  sessions: CanvasNode[];
  outputs: CanvasNode[];
  allOutputs: CanvasNode[];
}

export function canvasConversationGroupTarget(card?: CanvasConversationCard) {
  if (!card || (card.sessions.length < 2 && card.allOutputs.length < 2)) return undefined;
  const data = payload(card.anchor);
  const workflow = data.workflow_generation_group;
  const groupKey = data.generation_gallery_key || (typeof workflow === "string" && !workflow.startsWith("asset:") ? workflow : undefined)
    || (data.conversation_id || data.job_id ? `generation:${data.conversation_id || data.job_id}` : undefined);
  return groupKey ? { groupKey } : undefined;
}

/** Presentation only: keep exact turn identities and execution history intact. */
export function canvasConversationCards(nodes: readonly CanvasNode[], jobs: Record<string, Pick<GenJob, "conversationId"> & Partial<Pick<GenJob, "turns">>>, excluded: ReadonlySet<string> = new Set(), contained: ReadonlySet<string> = new Set(), routed: ReadonlySet<string> = new Set()) {
  const groups = new Map<string, CanvasConversationCard>();
  const aliases = new Map<string, string>();
  const embeddedSessions = new Map(nodes.filter(node => node.kind === "note" && node.hiddenAt == null)
    .flatMap(node => readCanvasNote(node).cells.flatMap(row => row.flatMap(cell => cell.content_type === "image" && cell.generation_ref
      ? [[cell.generation_ref.session_node_id, { nodeId: node.id, cellId: cell.id! }] as const] : []))));
  const conversationId = (node: CanvasNode) => {
    const turn = payload(node);
    return turn.conversation_id || jobs[turn.job_id]?.conversationId || turn.job_id;
  };
  // Explicit content cells keep their own sessions. Repeated workflow runs may
  // populate different rows; producer grouping must not merge those destinations.
  const structured = new Set(nodes.filter(node => node.kind === "prompt" && (routed.has(node.id) || embeddedSessions.has(node.id)))
    .map(node => JSON.stringify([node.projectId, conversationId(node)])));
  // Native timestamps have second precision. A fast failed retry can share its
  // timestamp with the previous turn; UUID order must not change the card anchor.
  const ordered = [...nodes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const tiedTurns = new Map<string, { slot: number; rank: number }[]>();
  ordered.forEach((node, slot) => {
    if (node.kind !== "prompt") return;
    const turn = payload(node);
    const rank = jobs[turn.job_id]?.turns?.findIndex(item => item.turnKey === turn.turn_key) ?? -1;
    if (rank < 0) return;
    const key = JSON.stringify([node.projectId, turn.job_id, node.createdAt]);
    const tied = tiedTurns.get(key) ?? [];
    tied.push({ slot, rank });
    tiedTurns.set(key, tied);
  });
  for (const tied of tiedTurns.values()) {
    const sorted = [...tied].sort((a, b) => a.rank - b.rank).map(item => ordered[item.slot]);
    tied.forEach((item, index) => { ordered[item.slot] = sorted[index]; });
  }
  for (const node of ordered) {
    if (node.kind !== "prompt" || node.hiddenAt != null || excluded.has(node.id)) continue;
    const turn = payload(node);
    if (!turn.job_id) continue;
    if (turn.generation_group_dissolved) continue;
    const originalConversation = conversationId(node);
    const explicitDestination = structured.has(JSON.stringify([node.projectId, originalConversation]));
    // Agent tool sessions retain their execution history, but their pictures are
    // independent canvas cards. Keep pending/failed sessions until a result exists.
    if (turn.workflow_generation_group?.startsWith("asset:") && !explicitDestination) {
      const firstOutput = ordered.find(output => output.kind === "asset" && output.role === "output" && output.assetId
        && output.projectId === node.projectId && output.hiddenAt == null && !contained.has(output.id)
        && payload(output).execution?.job_id === turn.job_id && payload(output).execution?.turn_key === turn.turn_key);
      if (firstOutput) { aliases.set(node.id, firstOutput.id); continue; }
    }
    const conversation = explicitDestination ? originalConversation
      : turn.workflow_generation_group || originalConversation;
    const key = JSON.stringify([node.projectId, conversation]);
    const card = groups.get(key) ?? { anchor: node, latest: node, sessions: [], outputs: [], allOutputs: [] };
    card.sessions.push(node);
    card.latest = node;
    groups.set(key, card);
    aliases.set(node.id, card.anchor.id);
  }
  for (const card of groups.values()) {
    const turns = new Set(card.sessions.map(node => { const turn = payload(node); return JSON.stringify([turn.job_id, turn.turn_key]); }));
    for (const node of ordered) {
      if (node.kind !== "asset" || node.role !== "output" || !node.assetId || node.hiddenAt != null || node.projectId !== card.anchor.projectId) continue;
      const execution = payload(node).execution;
      if (!execution || !turns.has(JSON.stringify([execution.job_id, execution.turn_key]))) continue;
      card.allOutputs.push(node);
      if (contained.has(node.id)) continue;
      card.outputs.push(node);
      aliases.set(node.id, card.anchor.id);
    }
    // Output UUID/node IDs are not chronological when native timestamps tie.
    // Turn order comes first; ULID asset IDs break ties within one turn.
    const ranks = new Map(card.sessions.map((node, index) => {
      const turn = payload(node);
      return [JSON.stringify([turn.job_id, turn.turn_key]), index];
    }));
    const compare = (a: CanvasNode, b: CanvasNode) => {
      const left = payload(a).execution, right = payload(b).execution;
      return (left.job_id === right.job_id ? ranks.get(JSON.stringify([left.job_id, left.turn_key]))! - ranks.get(JSON.stringify([right.job_id, right.turn_key]))! : 0)
        || a.createdAt - b.createdAt || a.assetId!.localeCompare(b.assetId!);
    };
    card.outputs.sort(compare);
    card.allOutputs.sort(compare);
  }
  // Video workflows and Agent finals can have no visible prompt/session node.
  // Only original production instances participate; copied references stay put.
  for (const node of ordered.filter(node => node.kind === "asset" && node.assetId && (/^(workflow-comfy|workflow-video|gen-output|agent-artifact):/.test(node.id)
    && (node.role === "output" || node.role === "final") || payload(node).generation_gallery_key?.startsWith("manual:") && (node.role !== "reference" || payload(node).manual_gallery_node))
    && node.hiddenAt == null && !aliases.has(node.id) && !excluded.has(node.id) && !contained.has(node.id))) {
    const group = payload(node).workflow_generation_group;
    if (payload(node).generation_group_dissolved) continue;
    if (typeof group !== "string") continue;
    const key = JSON.stringify([node.projectId, group]);
    const card = groups.get(key) ?? { anchor: node, latest: node, sessions: [], outputs: [], allOutputs: [] };
    card.outputs.push(node);
    card.allOutputs.push(node);
    if (!card.sessions.length) card.latest = node;
    groups.set(key, card);
    aliases.set(node.id, card.anchor.id);
  }
  for (const card of groups.values()) if (card.anchor.kind === "asset") {
    card.outputs.sort((a, b) => a.createdAt - b.createdAt || a.assetId!.localeCompare(b.assetId!));
    card.allOutputs = [...card.outputs];
    card.latest = card.outputs[card.outputs.length - 1];
  }
  for (const card of groups.values()) if (payload(card.anchor).generation_gallery_key?.startsWith("manual:")) {
    const compare = (a: CanvasNode, b: CanvasNode) => a.createdAt - b.createdAt || a.assetId!.localeCompare(b.assetId!);
    card.outputs.sort(compare); card.allOutputs.sort(compare);
  }
  const embedded = new Map<string, { nodeId: string; cellId: string }>();
  for (const card of groups.values()) {
    const target = card.sessions.map(session => embeddedSessions.get(session.id)).find(Boolean);
    if (target) for (const node of [...card.sessions, ...card.allOutputs]) embedded.set(node.id, target);
  }
  const routedIds = new Set([...groups.values()].filter(card => card.sessions.some(session => routed.has(session.id)))
    .flatMap(card => [...card.sessions, ...card.outputs].map(node => node.id)));
  return { cards: new Map([...groups.values()].map(card => [card.anchor.id, card])), aliases,
    embedded, routedIds, hiddenIds: new Set([...routedIds, ...embedded.keys(), ...[...aliases].filter(([id, anchor]) => id !== anchor).map(([id]) => id)]) };
}
