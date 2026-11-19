import type { CanvasNode } from "./types";
import { readCanvasNoteSource } from "./canvasNoteSource.ts";

/** Chat cards have their own durable history; the canvas note stores identity and layout only. */
export function canvasChatId(node: Pick<CanvasNode, "kind" | "payloadJson">): string | null {
  if (node.kind !== "note") return null;
  try {
    const value = readCanvasNoteSource(node);
    return value.note_type === "chat" && typeof value.conversation_id === "string" && value.conversation_id
      ? value.conversation_id : null;
  } catch { return null; }
}
