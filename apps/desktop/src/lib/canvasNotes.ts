import type { CanvasNode } from "./types";
import type { CanvasRect } from "./canvasLogic";

export interface CanvasTextCell {
  content_type?: "text" | "image";
  id?: string;
  text: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  image_refs?: { asset_id: string; token: string }[];
}

/** Only references whose visible index remains in the cell are forwarded. */
export function canvasCellValue(cell: CanvasTextCell) {
  const refs = cell.image_refs?.filter(ref => cell.content_type === "image" || cell.text.split(ref.token).slice(1).some(suffix => !/^\d/.test(suffix))) ?? [];
  return { type: "text" as const, text: cell.text, assetIds: refs.map(ref => ref.asset_id), imageRefs: refs };
}

export interface CanvasNotePayload {
  schema_version: 1;
  text: string;
  note_type: "text" | "section" | "bubble" | "images";
  cells: CanvasTextCell[][];
  member_ids: string[];
  line_height_percent?: number;
  bubble_tail?: CanvasBubbleTail;
  title?: string;
  column_widths?: number[];
  row_heights?: number[];
}

export interface CanvasBubbleTail {
  side: "top" | "right" | "bottom" | "left";
  position: number;
}

export function canvasNoteValue(note: CanvasNotePayload, cellId: string) {
  if (cellId === "*") {
    const cells = note.cells.flat();
    return { type: "image" as const, assetIds: [...new Set(cells.flatMap(cell => canvasCellValue(cell).assetIds))] };
  }
  if (cellId === "*text") {
    const cells = note.cells.flat().filter(cell => cell.content_type !== "image");
    const values = cells.map(canvasCellValue);
    const assetIds = [...new Set(values.flatMap(value => value.assetIds))];
    const text = values.map(value => value.text.replace(/@图片\d+/g, token => {
      const ref = value.imageRefs.find(ref => ref.token === token);
      return ref ? `@图片${assetIds.indexOf(ref.asset_id) + 1}` : token;
    })).join("\n");
    return { type: "text" as const, text, assetIds, imageRefs: assetIds.map((asset_id, i) => ({ asset_id, token: `@图片${i + 1}` })) };
  }
  const cell = note.cells.flat().find(cell => cell.id === cellId);
  if (cell?.content_type === "image") {
    const cells = [cell];
    return cells.length ? { type: "image" as const, assetIds: [...new Set(cells.flatMap(cell => cell.image_refs?.map(ref => ref.asset_id) ?? []))] } : undefined;
  }
  return cell ? canvasCellValue(cell) : undefined;
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

export const emptyCanvasCell = (): CanvasTextCell => ({ content_type: "text", text: "", bold: false, italic: false, align: "left" });

export function canvasTextMinSize(cells: CanvasTextCell[][], images = false, bubble = false) {
  if (bubble) return { width: Math.max(200, cells[0].length * 120 + 16), height: (cells.length * 64 + 40) * 0.8 };
  return { width: Math.max(200, cells[0].length * 120 + 73.6), height: (images || cells.some(row => row.some(cell => cell.content_type === "image")) ? cells.length * 120 : cells.length * 64) + 46 };
}

/** Fall back to equal weights unless the saved vector matches the grid and stays positive. */
export function canvasGridWeights(saved: number[] | undefined, count: number): number[] {
  if (!saved || saved.length !== count || saved.some(weight => !(weight > 0))) return Array.from({ length: count }, () => 1);
  return saved;
}

/** RFC-4180-style CSV: quote fields containing commas, quotes or line breaks. */
export function canvasTextCsv(cells: CanvasTextCell[][]): string {
  return cells.map(row => row.map(({ text }) =>
    /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text).join(",")).join("\n");
}

export function readCanvasNote(node: Pick<CanvasNode, "payloadJson">): CanvasNotePayload {
  const value = JSON.parse(node.payloadJson);
  return {
    schema_version: 1,
    text: value.text ?? "",
    note_type: value.note_type === "images" ? "images" : value.note_type === "section" ? "section" : value.note_type === "bubble" ? "bubble" : "text",
    cells: (value.note_type === "section" ? [] : value.cells?.length ? value.cells : [[{ ...emptyCanvasCell(), text: value.text ?? "" }]])
      .map((row: CanvasTextCell[], r: number) => row.map((cell, c) => ({ ...cell, ...(value.note_type === "images" && !cell.content_type ? { content_type: "image" } : {}), id: cell.id ?? `cell-${r}-${c}` }))),
    member_ids: value.member_ids ?? [],
    line_height_percent: value.line_height_percent ?? 165,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(Array.isArray(value.column_widths) ? { column_widths: value.column_widths } : {}),
    ...(Array.isArray(value.row_heights) ? { row_heights: value.row_heights } : {}),
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
