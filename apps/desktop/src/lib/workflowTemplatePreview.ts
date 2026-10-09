import { readCanvasNote } from "./canvasNotes";
import { workflowTitle, type WorkflowNode, type WorkflowInput } from "./canvasWorkflow";
import type { CanvasNode } from "./types";

export interface TemplatePreviewCard { id: string; x: number; y: number; width: number; height: number; title: string; body: string; assets: string[]; kind: "workflow" | "text" | "image" }
export interface TemplatePreviewLink { from: string; to: string; output: string; input: string; type: string }
export function templateSourceCard(input: WorkflowInput, canvas: CanvasNode[]) {
  return input.nodeId ?? input.canvasNodeId ?? input.assetNodeId ?? input.groupId ?? (input.assetId ? canvas.find(node => node.assetId === input.assetId && node.hiddenAt == null)?.id : undefined);
}
export function templatePreview(nodes: WorkflowNode[], canvas: CanvasNode[], selected: string[], bounds: { id: string; x: number; y: number; width: number; height: number; assetIds?: string[] }[]) {
  const cards: TemplatePreviewCard[] = [];
  for (const id of selected) {
    const workflow = nodes.find(node => node.id === id), native = canvas.find(node => node.id === id), rect = bounds.find(node => node.id === id) ?? native ?? (workflow && { ...workflow, width: 320, height: 330 });
    if (!rect || workflow?.kind === "text") continue;
    const note = native?.kind === "note" ? readCanvasNote(native) : undefined;
    if (note?.note_type === "section") continue;
    cards.push({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      kind: workflow ? "workflow" : native?.kind === "asset" || !native ? "image" : "text",
      title: workflow ? workflowTitle(workflow) : note?.title || (native?.kind === "asset" ? "图片素材" : native ? "内容卡" : "素材组"),
      body: workflow ? workflow.prompt.replace(/@\[([^\]]+)\]/g, (_, id) => `@${workflow.promptReferences?.find(ref => ref.id === id)?.label ?? "输入"}`) : note?.cells.flat().map(cell => cell.text).filter(Boolean).join("\n") ?? "",
      assets: native?.assetId ? [native.assetId] : note ? [...new Set(note.cells.flat().flatMap(cell => cell.image_refs?.map(ref => ref.asset_id) ?? []))] : (rect as { assetIds?: string[] }).assetIds ?? [] });
  }
  const links: TemplatePreviewLink[] = [];
  for (const node of nodes) for (const [port, inputs] of Object.entries(node.inputs)) for (const binding of inputs) {
    const from = templateSourceCard(binding, canvas), to = node.textTarget?.nodeId ?? node.id;
    if (from && (selected.includes(from) || selected.includes(to))) links.push({ from, to, output: binding.portId ?? binding.cellId ?? port, input: node.textTarget?.cellId ?? port, type: port });
  }
  return { cards, links };
}
