import type { CanvasNode } from "./types";

type CanvasNodePayload = Record<string, unknown> & {
  snapshot?: { name: string; width?: number; height?: number };
  execution?: { job_id?: string; turn_key?: string | null };
  job_id?: string;
  turn_key?: string | null;
  status?: string;
  conversation_id?: string;
  workflow_generation_group?: string;
  workflow_source?: string;
  generation_gallery_key?: string;
  generation_group_dissolved?: boolean;
  manual_gallery_node?: boolean;
  artboard?: { base_asset_id?: unknown };
};

const parsedPayloads = new WeakMap<CanvasNode, Record<string, unknown>>();

// Canvas snapshots and edits replace nodes when their stored payload changes.
export function canvasNodePayload(node: CanvasNode): CanvasNodePayload {
  let payload = parsedPayloads.get(node);
  if (!payload) {
    try {
      const value: unknown = JSON.parse(node.payloadJson);
      payload = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      payload = {};
    }
    parsedPayloads.set(node, payload);
  }
  return payload as CanvasNodePayload;
}
