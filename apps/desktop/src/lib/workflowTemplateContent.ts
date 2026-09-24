import { api } from "./api";
import { canvasInputValue } from "./canvasSessionOutputs";
import { emptyCanvasCell } from "./canvasNotes";
import type { CanvasNode } from "./types";
import type { WorkflowInput, WorkflowNode, WorkflowValue } from "./canvasWorkflow";
import { parseWorkflowTemplate, type WorkflowTemplate } from "./workflowTemplates";

/** Freeze input values, never upstream execution/session identities. */
export function templateInputValue(binding: WorkflowInput, type: "text" | "image", nodes: WorkflowNode[], canvas: CanvasNode[]): WorkflowValue | undefined {
  if (binding.canvasNodeId) {
    const source = canvas.find(node => node.id === binding.canvasNodeId && node.hiddenAt == null);
    return source && canvasInputValue(source, binding.cellId ?? "", canvas);
  }
  if (binding.nodeId) return nodes.find(node => node.id === binding.nodeId)?.outputs[binding.portId ?? type];
  if (binding.assetId) return { type: "image", assetIds: [binding.assetId] };
  if (binding.groupId) return { type: "image", assetIds: binding.assetIds ?? [] };
}

export async function includeTemplateContent(template: WorkflowTemplate, values: Record<string, WorkflowValue | undefined>, images: boolean, text: boolean) {
  const result = structuredClone(template);
  result.schemaVersion = 2;
  const files = new Map<string, string>();
  for (const input of result.inputs) {
    if (input.type === "image" ? !images : !text) continue;
    const value = values[input.id];
    if (!value || value.type !== input.type || (input.type === "image" ? !value.assetIds?.length : !value.text?.trim())) throw new Error(`「${input.label}」尚无可携带的内容，请先补充或取消携带`);
    input.content = input.type === "text" ? { text: value.text } : {};
    if (!images) continue;
    const refs = input.type === "text" ? value.imageRefs ?? [] : (value.assetIds ?? []).map(asset_id => ({ asset_id, token: undefined }));
    input.content.images = [];
    for (const ref of refs) {
      if (!files.has(ref.asset_id)) {
        const [asset] = await api.getAssetsByIds([ref.asset_id]);
        if (!asset?.store_path) throw new Error(`「${input.label}」的原素材已不存在`);
        files.set(ref.asset_id, await api.readImageDataUrl(asset.store_path));
      }
      input.content.images.push({ dataUrl: files.get(ref.asset_id)!, ...(ref.token ? { token: ref.token } : {}) });
    }
  }
  return parseWorkflowTemplate(JSON.stringify(result));
}

/** Populate fresh local content cards only when the user adds the template. */
export async function materializeTemplateContent(template: WorkflowTemplate, selected: Record<string, WorkflowInput>, projectId: string, x: number, y: number) {
  const bindings = structuredClone(selected), created: string[] = [];
  const assets = new Map<string, string>();
  for (const input of template.inputs) {
    if (bindings[input.id] || !input.content) continue;
    const imageRefs: { asset_id: string; token: string }[] = [];
    for (const [index, picture] of (input.content.images ?? []).entries()) {
      if (!assets.has(picture.dataUrl)) {
        const ext = picture.dataUrl.match(/^data:image\/(\w+);/)![1];
        const asset = await api.importImageBytes({ dataUrl: picture.dataUrl, fileName: `模板素材-${index + 1}.${ext}`, projectId, source: "workflow-template" });
        assets.set(picture.dataUrl, asset.id);
      }
      imageRefs.push({ asset_id: assets.get(picture.dataUrl)!, token: picture.token ?? `@图片${index + 1}` });
    }
    const id = crypto.randomUUID(), cellId = crypto.randomUUID();
    const cell = { ...emptyCanvasCell(), id: cellId, content_type: input.type, text: input.content.text ?? "", image_refs: imageRefs };
    await api.projectCanvasNodeCreate({ id, projectId, threadId: null, kind: "note", assetId: null, role: null,
      x, y: y + created.length * 240, width: 320, height: 200, zIndex: 1, positionLocked: false,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: "text", title: input.label, text: "", cells: [[cell]], member_ids: [] }) });
    created.push(id);
    // Reuse already-created bindings if a later step fails and the user retries.
    selected[input.id] = bindings[input.id] = { canvasNodeId: id, cellId };
  }
  return { bindings, created };
}
