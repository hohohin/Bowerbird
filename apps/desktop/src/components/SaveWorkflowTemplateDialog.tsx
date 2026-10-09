import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { CanvasNode } from "../lib/types";
import type { WorkflowInput, WorkflowNode } from "../lib/canvasWorkflow";
import { captureWorkflowTemplate } from "../lib/workflowTemplates";
import { includeTemplateContent, templateInputValue } from "../lib/workflowTemplateContent";
import { ModalShell } from "./ModalShell";
import { WorkflowTemplatePreview } from "./WorkflowTemplatePreview";
import { templatePreview, templateSourceCard, type TemplatePreviewCard } from "../lib/workflowTemplatePreview";
import type { WorkflowTemplate } from "../lib/workflowTemplates";

export function SaveWorkflowTemplateDialog({ nodes, selectedIds, graphNodes, bounds, mode = "template", onEncapsulate, onClose, onSaved }: {
  nodes: WorkflowNode[]; selectedIds: string[]; graphNodes: CanvasNode[]; bounds: Omit<TemplatePreviewCard, "title" | "body" | "assets" | "kind">[];
  mode?: "template" | "container"; onEncapsulate: (name: string, members: string[], template: WorkflowTemplate | null) => Promise<unknown>; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(mode === "template" ? "新流程模板" : "新子流程");
  const [carryImages, setCarryImages] = useState(true), [carryText, setCarryText] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview] = useState(() => templatePreview(nodes, graphNodes, selectedIds, bounds));
  const [enclosed, setEnclosed] = useState(new Set(preview.cards.map(card => card.id)));
  // Keep exactly the selection and source values the user confirmed, even if the canvas changes.
  const [selection] = useState(() => {
    try {
      const bindings: Record<string, WorkflowInput> = {};
      const template = captureWorkflowTemplate(nodes, new Set(selectedIds), "新流程模板", bindings);
      const values = Object.fromEntries(template.inputs.map(input => [input.id, structuredClone(templateInputValue(bindings[input.id], input.type, nodes, graphNodes))]));
      return { template, values, error: "" };
    } catch (reason) { return { error: String(reason), template: undefined, values: undefined }; }
  });
  const layout = useMemo(() => {
    if (!selection.template) return [];
    const bindings: Record<string, WorkflowInput> = {};
    captureWorkflowTemplate(nodes, new Set(selectedIds), name || "模板", bindings);
    const work = nodes.filter(node => selectedIds.includes(node.id) && node.kind !== "trigger");
    const minX = Math.min(...preview.cards.map(card => card.x)), minY = Math.min(...preview.cards.map(card => card.y));
    return preview.cards.map((card, index) => {
      const node = nodes.find(node => node.id === card.id);
      return { id: `item${index + 1}`, x: card.x - minX, y: card.y - minY, width: card.width, height: card.height, enclosed: enclosed.has(card.id),
        ...(node ? { node: node.kind === "trigger" ? "start" : `card${work.findIndex(node => node.id === card.id) + 1}` }
          : { type: card.kind === "image" || !card.body.trim() && card.assets.length ? "image" as const : "text" as const, inputs: Object.entries(bindings).filter(([, binding]) => templateSourceCard(binding, graphNodes) === card.id).map(([id]) => id) }) };
    });
  }, [enclosed, preview, selection, nodes, selectedIds, graphNodes, name]);
  return <ModalShell title={mode === "template" ? "存为模板" : "封装选区"} width="lg" className="workflow-template-save-modal" preventClose={busy} onClose={onClose}
    panelProps={{ onPointerDown: event => event.stopPropagation(), onWheel: event => event.stopPropagation(), onKeyDown: event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); } }}
    footer={<><span className="workflow-template-save-count">{enclosed.size} 张放入容器 · {preview.cards.length - enclosed.size} 张保留外部</span><button className="app-modal-button" disabled={busy} onClick={onClose}>取消</button><button className="app-modal-button is-primary" disabled={busy || !name.trim() || (mode === "template" ? !selection.template : !enclosed.size)} onClick={() => {
      setBusy(true); setError("");
      void (async () => {
        try {
          let saved: WorkflowTemplate | null = null;
          if (mode === "template") {
            const template = selection.template!;
            const values = { ...selection.values };
            for (const [index, card] of preview.cards.entries()) if (card.kind !== "workflow") {
              values[`item${index + 1}`] = card.kind === "image" || !card.body.trim() && card.assets.length ? { type: "image", assetIds: card.assets } : { type: "text", text: card.body };
            }
            saved = await includeTemplateContent({ ...template, schemaVersion: 3, layout, name: name.trim(), plan: { ...template.plan, summary: name.trim() } }, values, carryImages, carryText);
          }
          if (enclosed.size) await onEncapsulate(name.trim(), [...enclosed], saved);
          else if (saved) await api.workflowTemplateSave(saved);
          onSaved(); onClose();
        } catch (reason) { setError(String(reason)); }
        finally { setBusy(false); }
      })();
    }}>{busy ? "正在保存…" : mode === "template" ? "保存" : "封装"}</button></>}>
    <div className="workflow-template-library workflow-template-save">
      {(error || mode === "template" && selection.error) && <p role="alert" className="workflow-error">{error || selection.error}</p>}
      <label>{mode === "template" ? "模板名称" : "容器名称"}<input data-modal-autofocus aria-label={mode === "template" ? "模板名称" : "容器名称"} maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <WorkflowTemplatePreview cards={preview.cards} links={preview.links} enclosed={enclosed} disabled={busy} onToggle={id => setEnclosed(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; })} />
      {mode === "template" && <div className="workflow-template-save-options">
      {selection.template && <p>保存整个选区。仅勾选的卡片放入容器，其余卡片保留在外部。</p>}
      <label><input type="checkbox" checked={carryImages} disabled={busy} onChange={event => setCarryImages(event.target.checked)} />带上素材</label>
      <p>附带这些步骤用到的输入图片，换设备后也可使用。</p>
      <label><input type="checkbox" checked={carryText} disabled={busy} onChange={event => setCarryText(event.target.checked)} />带上文本</label>
      <p>附带内容卡中的输入文案。流程卡片里的操作指令始终保留。</p>
      <p>未携带的内容会留作待填输入，使用模板时再选择素材或文案。</p>
      </div>}
    </div>
  </ModalShell>;
}
