import type { CanvasNode } from "./types";

/** Chat cards have their own durable history; the canvas note stores identity and layout only. */
export function canvasChatId(node: Pick<CanvasNode, "kind" | "payloadJson">): string | null {
  if (node.kind !== "note") return null;
  try {
    const value = JSON.parse(node.payloadJson);
    return value.note_type === "chat" && typeof value.conversation_id === "string" && value.conversation_id
      ? value.conversation_id : null;
  } catch { return null; }
}
