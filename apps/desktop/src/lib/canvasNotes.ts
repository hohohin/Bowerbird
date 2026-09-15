import type { CanvasNode } from "./types";
import type { CanvasRect } from "./canvasLogic";

export interface CanvasTextCell {
  text: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export interface CanvasNotePayload {
  schema_version: 1;
  text: string;
  note_type: "text" | "section" | "bubble";
  cells: CanvasTextCell[][];
  member_ids: string[];
  line_height_percent?: number;
  bubble_tail?: CanvasBubbleTail;
}

export interface CanvasBubbleTail {
  side: "top" | "right" | "bottom" | "left";
  position: number;
}

export function canvasBubbleTailAt(x: number, y: number, width: number, height: number): CanvasBubbleTail {
  const alongX = Math.max(24, Math.min(width - 24, x));
  const alongY = Math.max(24, Math.min(height - 24, y));
  const edges = [
    { side: "top", x: alongX, y: 0, position: alongX / width },
    { side: "right", x: width, y: alongY, position: alongY / height },
    { side: "bottom", x: alongX, y: height, position: alongX / width },
    { side: "left", x: 0, y: alongY, position: alongY / height },
  ] as const;
  const nearest = [...edges].sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y))[0];
  return { side: nearest.side, position: Math.round(nearest.position * 100) };
}

export const emptyCanvasCell = (): CanvasTextCell => ({ text: "", bold: false, italic: false, align: "left" });

export function canvasTextMinSize(cells: CanvasTextCell[][]) {
  return { width: Math.max(200, cells[0].length * 120 + 16), height: (cells.length * 64 + 40) * 0.8 };
}

export function readCanvasNote(node: Pick<CanvasNode, "payloadJson">): CanvasNotePayload {
  const value = JSON.parse(node.payloadJson);
  return {
    schema_version: 1,
    text: value.text ?? "",
    note_type: value.note_type === "section" ? "section" : value.note_type === "bubble" ? "bubble" : "text",
    cells: value.note_type === "section" ? [] : value.cells?.length ? value.cells : [[{ ...emptyCanvasCell(), text: value.text ?? "" }]],
    member_ids: value.member_ids ?? [],
    line_height_percent: value.line_height_percent ?? 165,
    ...(value.note_type === "bubble" ? { bubble_tail: value.bubble_tail ?? { side: "bottom", position: 25 } } : {}),
  };
}

export function canvasSectionMembers(rect: CanvasRect, anchors: { id: string; rect: CanvasRect }[]) {
  return anchors.filter(({ rect: card }) => card.x >= rect.x && card.y >= rect.y
    && card.x + card.width <= rect.x + rect.width && card.y + card.height <= rect.y + rect.height)
    .map(({ id }) => id);
}

/** Membership is explicit: overlapping sections do not acquire each other. */
export function expandCanvasSections(ids: Set<string>, graph: CanvasNode[]): Set<string> {
  const next = new Set(ids);
  for (const node of graph) {
    if (node.kind !== "note" || node.hiddenAt != null || !ids.has(node.id)) continue;
    const note = readCanvasNote(node);
    if (note.note_type === "section") for (const id of note.member_ids) next.add(id);
  }
  return next;
}
