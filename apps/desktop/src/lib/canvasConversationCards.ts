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
}

/** Presentation only: keep exact turn identities and execution history intact. */
export function canvasConversationCards(nodes: readonly CanvasNode[], jobs: Record<string, Pick<GenJob, "conversationId"> & Partial<Pick<GenJob, "turns">>>, excluded: ReadonlySet<string> = new Set(), contained: ReadonlySet<string> = new Set(), routed: ReadonlySet<string> = new Set()) {
  const groups = new Map<string, CanvasConversationCard>();
  const aliases = new Map<string, string>();
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
    const conversation = jobs[turn.job_id]?.conversationId ?? turn.job_id;
    const key = JSON.stringify([node.projectId, conversation]);
    const card = groups.get(key) ?? { anchor: node, latest: node, sessions: [], outputs: [] };
    card.sessions.push(node);
    card.latest = node;
    groups.set(key, card);
    aliases.set(node.id, card.anchor.id);
  }
  for (const card of groups.values()) {
    const turns = new Set(card.sessions.map(node => { const turn = payload(node); return JSON.stringify([turn.job_id, turn.turn_key]); }));
    for (const node of ordered) {
      if (node.kind !== "asset" || node.role !== "output" || !node.assetId || node.hiddenAt != null || contained.has(node.id) || node.projectId !== card.anchor.projectId) continue;
      const execution = payload(node).execution;
      if (!execution || !turns.has(JSON.stringify([execution.job_id, execution.turn_key]))) continue;
      card.outputs.push(node);
      aliases.set(node.id, card.anchor.id);
    }
  }
  const embeddedSessions = new Map(nodes.filter(node => node.kind === "note" && node.hiddenAt == null)
    .flatMap(node => readCanvasNote(node).cells.flatMap(row => row.flatMap(cell => cell.content_type === "image" && cell.generation_ref
      ? [[cell.generation_ref.session_node_id, { nodeId: node.id, cellId: cell.id! }] as const] : []))));
  const embedded = new Map<string, { nodeId: string; cellId: string }>();
  for (const card of groups.values()) {
    const target = card.sessions.map(session => embeddedSessions.get(session.id)).find(Boolean);
    if (target) for (const node of [...card.sessions, ...card.outputs]) embedded.set(node.id, target);
  }
  const routedIds = new Set([...groups.values()].filter(card => card.sessions.some(session => routed.has(session.id)))
    .flatMap(card => [...card.sessions, ...card.outputs].map(node => node.id)));
  return { cards: new Map([...groups.values()].map(card => [card.anchor.id, card])), aliases,
    embedded, routedIds, hiddenIds: new Set([...routedIds, ...embedded.keys(), ...[...aliases].filter(([id, anchor]) => id !== anchor).map(([id]) => id)]) };
}
