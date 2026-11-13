import type { CanvasNode } from "./types";

type Source = Pick<CanvasNode, "payloadJson">;
const documents = new WeakMap<Source, { json: string; payload: ReturnType<typeof JSON.parse> }>();

/** Read-only source for note type checks and normalization. Evicted with the graph snapshot. */
export function readCanvasNoteSource(node: Source) {
  const saved = documents.get(node);
  if (saved?.json === node.payloadJson) return saved.payload;
  const payload = JSON.parse(node.payloadJson);
  if (payload?.note_type === "document") documents.set(node, { json: node.payloadJson, payload });
  else if (saved) documents.delete(node);
  return payload;
}
