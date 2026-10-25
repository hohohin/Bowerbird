import { newWorkflowNode, type WorkflowNode } from "./canvasWorkflow";
import { emptyCanvasCell, type CanvasNotePayload } from "./canvasNotes";
import { DEFAULT_VIDEO_OPTIONS } from "./videoGeneration";
import type { ReplicationWorkflowRequest } from "./videoReplication";
import type { CanvasNode as ProjectGraphNode } from "./types";

/** Stable IDs make a partially saved handoff retryable without duplicating cards. */
export function replicationWorkflow(request: ReplicationWorkflowRequest, projectId: string, provider: string, x: number, y: number) {
  const prefix = `replication-${request.id}`;
  const image: WorkflowNode = { ...newWorkflowNode("generation", x, y, provider), id: `${prefix}-image`, prompt: request.prompt,
    ratio: request.ratio, generation: { media: "image", count: 1 } };
  if (request.referenceId) {
    const input = { assetId: request.referenceId, slot: 1 };
    image.inputs.image = [input]; image.prompt += "\n\n参考图：@[replication-frame]";
    image.promptReferences = [{ id: "replication-frame", type: "image", label: "视频截帧", slot: 1, input }];
  }
  const notes: ProjectGraphNode[] = [];
  function content(suffix: string, title: string, left: number, source: WorkflowNode) {
    const id = `${prefix}-${suffix}`, cellId = `${id}-cell`;
    const payload: CanvasNotePayload = { schema_version: 1, note_type: "text", title, text: "", member_ids: [], cells: [[{ ...emptyCanvasCell(), id: cellId, content_type: "image" }]] };
    notes.push({ id, projectId, threadId: null, kind: "note", assetId: null, role: null, payloadJson: JSON.stringify(payload), x: left, y, width: 280, height: 260, zIndex: 1, positionLocked: false, hiddenAt: null, createdAt: Date.now(), updatedAt: Date.now() });
    return { ...newWorkflowNode("text", left, y, ""), id: `${id}-writer`, textTarget: { nodeId: id, cellId, append: true, image: true, appendAxis: "column" as const, axisCellIds: [cellId] }, inputs: { image: [{ nodeId: source.id, portId: "image", slot: 1 }] } };
  }
  const images = content("images", "首帧图片", x + 420, image);
  const input = { nodeId: images.id, portId: "image", slot: 1 };
  const video: WorkflowNode = { ...newWorkflowNode("generation", x + 760, y, "jimeng"), id: `${prefix}-video`, ratio: request.ratio,
    prompt: request.videoPrompt + "\n\n首帧：@[replication-first-frame]", inputs: { image: [input] },
    promptReferences: [{ id: "replication-first-frame", type: "image", label: "首帧图片", slot: 1, input }],
    generation: { media: "video", videoChannel: "jimeng", videoOptions: { ...DEFAULT_VIDEO_OPTIONS, kind: "image2video", duration: request.duration } } };
  const videos = content("videos", "视频结果", x + 1180, video);
  return { nodes: [image, images, video, videos], notes, rect: { x, y, width: 1460, height: 680 }, selectedId: image.id };
}
