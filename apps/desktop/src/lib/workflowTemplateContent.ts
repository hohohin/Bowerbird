import { api } from "./api";
import { canvasInputValue } from "./canvasSessionOutputs";
import { emptyCanvasCell, type CanvasTextCell } from "./canvasNotes";
import { contentTableText, parseTextTable } from "./contentTable";
import type { CanvasNode } from "./types";
import type { WorkflowInput, WorkflowNode, WorkflowValue } from "./canvasWorkflow";
import { parseWorkflowTemplate, type TemplateContent, type WorkflowTemplate } from "./workflowTemplates";

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
  result.schemaVersion = result.schemaVersion >= 4 ? 4 : result.layout ? 3 : 2;
  const files = new Map<string, string>();
  const targets: { id: string; label?: string; type?: "text" | "image"; content?: TemplateContent; whole?: boolean }[] = [...result.inputs, ...(result.layout ?? []).filter(card => !card.node && !card.inputs?.length)];
  for (const input of targets) {
    delete input.content;
    if (input.type === "image" ? !images : !text) continue;
    const value = values[input.id];
    if (!input.label && (!value || value.type === "text" && !value.text?.trim() || value.type === "image" && !value.assetIds?.length)) continue;
    if (!value || value.type !== input.type || (input.type === "image" ? !value.assetIds?.length : !value.text?.trim())) throw new Error(`「${input.label ?? "内容卡"}」尚无可携带的内容，请先补充或取消携带`);
    input.content = input.type === "text" ? { text: input.whole && value.table ? contentTableText(value.table) : value.text } : {};
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
export async function materializeTemplateContent(template: WorkflowTemplate, selected: Record<string, WorkflowInput>, projectId: string, x: number, y: number, layoutIds: Record<string, string> = {}) {
  const bindings = structuredClone(selected), created: string[] = [];
  const assets = new Map<string, string>();
  const native = (template.layout ?? []).filter(card => !card.node);
  const assigned = new Set(native.flatMap(card => card.inputs ?? []));
  const groups = [...native.flatMap(card => {
    const inputs = card.inputs?.length ? template.inputs.filter(input => card.inputs!.includes(input.id)) : [{ id: card.id, label: "内容卡", type: card.type!, content: card.content, whole: false }];
    // A whole table cannot share a flattened row with unrelated input slots.
    if (inputs.some(input => input.whole)) return inputs.map((input, i) => ({ card: i === 0 ? card : undefined, inputs: [input] }));
    return [{ card, inputs }];
  }),
    ...template.inputs.filter(input => !assigned.has(input.id)).map(input => ({ card: undefined, inputs: [input] }))];
  for (const group of groups) {
    if (group.card && layoutIds[group.card.id]) continue;
    const inputs = group.inputs.filter(input => !bindings[input.id] && (template.schemaVersion >= 4 || input.content || group.card && !group.card.inputs?.length));
    if (!inputs.length) {
      const existing = bindings[group.inputs[0]?.id];
      const id = existing?.canvasNodeId ?? existing?.assetNodeId ?? existing?.nodeId ?? existing?.groupId;
      if (group.card && id) layoutIds[group.card.id] = id;
      continue;
    }
    const cells: CanvasTextCell[] = [];
    for (const input of inputs) {
      const imageRefs: { asset_id: string; token: string }[] = [];
      for (const [index, picture] of (input.content?.images ?? []).entries()) {
        if (!assets.has(picture.dataUrl)) {
          const ext = picture.dataUrl.match(/^data:image\/(\w+);/)![1];
          const asset = await api.importImageBytes({ dataUrl: picture.dataUrl, fileName: `模板素材-${index + 1}.${ext}`, projectId, source: "workflow-template" });
          assets.set(picture.dataUrl, asset.id);
        }
        imageRefs.push({ asset_id: assets.get(picture.dataUrl)!, token: picture.token ?? `@图片${index + 1}` });
      }
      cells.push({ ...emptyCanvasCell(), id: crypto.randomUUID(), content_type: input.type, text: input.content?.text ?? "", image_refs: imageRefs });
    }
    const whole = inputs.length === 1 && inputs[0].whole;
    const rows = whole && inputs[0].content?.text ? parseTextTable(inputs[0].content.text) : null;
    const grid = rows ? rows.map(row => row.map(text => {
      const refs = cells[0].image_refs?.filter(ref => text.split(ref.token).slice(1).some(suffix => !/^\d/.test(suffix))) ?? [];
      const imageOnly = refs.length > 0 && refs.reduce((rest, ref) => rest.replaceAll(ref.token, ""), text).trim() === "";
      return { ...emptyCanvasCell(), id: crypto.randomUUID(), text: imageOnly ? "" : text, content_type: imageOnly ? "image" as const : "text" as const, image_refs: refs };
    })) : [cells];
    const id = crypto.randomUUID();
    await api.projectCanvasNodeCreate({ id, projectId, threadId: null, kind: "note", assetId: null, role: null,
      x: x + (group.card?.x ?? 0), y: y + (group.card?.y ?? created.length * 240), width: group.card?.width ?? 320, height: group.card?.height ?? 200, zIndex: 1, positionLocked: false,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: "text", title: inputs[0].label, text: "", cells: grid, member_ids: [] }) });
    created.push(id);
    if (group.card) layoutIds[group.card.id] = id;
    // Reuse already-created bindings if a later step fails and the user retries.
    inputs.forEach((input, i) => { selected[input.id] = bindings[input.id] = { canvasNodeId: id, cellId: input.whole ? "*text" : cells[i].id }; });
  }
  return { bindings, created, layoutIds };
}
