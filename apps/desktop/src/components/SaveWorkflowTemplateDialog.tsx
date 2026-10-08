import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { CanvasNode } from "../lib/types";
import type { WorkflowInput, WorkflowNode } from "../lib/canvasWorkflow";
import { captureWorkflowTemplate } from "../lib/workflowTemplates";
import { includeTemplateContent, templateInputValue } from "../lib/workflowTemplateContent";
import { ModalShell } from "./ModalShell";

export function SaveWorkflowTemplateDialog({ nodes, selectedIds, graphNodes, mode = "template", onClose, onSaved }: {
  nodes: WorkflowNode[]; selectedIds: string[]; graphNodes: CanvasNode[]; onClose: () => void; onSaved: () => void;
  mode?: "template" | "package";
}) {
  const exporting = mode === "package";
  const [name, setName] = useState(exporting ? "分享工作流" : "新流程模板");
  const [carryImages, setCarryImages] = useState(true), [carryText, setCarryText] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Keep exactly the selection and source values the user confirmed, even if the canvas changes.
  const [selection] = useState(() => {
    try {
      const bindings: Record<string, WorkflowInput> = {};
      const template = captureWorkflowTemplate(nodes, new Set(selectedIds), "新流程模板", bindings);
      const values = Object.fromEntries(template.inputs.map(input => [input.id, structuredClone(templateInputValue(bindings[input.id], input.type, nodes, graphNodes))]));
      return { template, values, error: "" };
    } catch (reason) { return { error: String(reason), template: undefined, values: undefined }; }
  });
  return <ModalShell title={exporting ? "导出工作流数据包" : "存为模板"} width="sm" preventClose={busy} onClose={onClose}
    panelProps={{ onPointerDown: event => event.stopPropagation(), onWheel: event => event.stopPropagation(), onKeyDown: event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); } }}
    footer={<><button className="app-modal-button" disabled={busy} onClick={onClose}>取消</button><button className="app-modal-button is-primary" disabled={busy || !name.trim() || !selection.template} onClick={() => {
      setBusy(true); setError("");
      void (async () => {
        try {
          const path = exporting ? await save({ defaultPath: `${name.trim().replace(/[<>:"/\\|?*]/g, "_")}.bbworkflow.json`, filters: [{ name: "Bowerbird 工作流数据包", extensions: ["json"] }] }) : null;
          if (exporting && !path) return;
          const template = selection.template!;
          const saved = await includeTemplateContent({ ...template, name: name.trim(), plan: { ...template.plan, summary: name.trim() } }, selection.values!, carryImages, carryText);
          if (exporting) await api.workflowTemplateExportDocument(saved, path!);
          else await api.workflowTemplateSave(saved);
          onSaved(); onClose();
        } catch (reason) { setError(String(reason)); }
        finally { setBusy(false); }
      })();
    }}>{busy ? (exporting ? "正在导出…" : "正在保存…") : (exporting ? "导出数据包" : "保存")}</button></>}>
    <div className="workflow-template-library workflow-template-save">
      {(error || selection.error) && <p role="alert" className="workflow-error">{error || selection.error}</p>}
      <label>{exporting ? "工作流名称" : "模板名称"}<input data-modal-autofocus aria-label={exporting ? "工作流名称" : "模板名称"} maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      {selection.template && <p>保存选中的 {selection.template.plan.nodes.length - 1} 个流程步骤及其输入连接。</p>}
      <label><input type="checkbox" checked={carryImages} disabled={busy} onChange={event => setCarryImages(event.target.checked)} />带上素材</label>
      <p>附带这些步骤用到的输入图片，换设备后也可使用。</p>
      <label><input type="checkbox" checked={carryText} disabled={busy} onChange={event => setCarryText(event.target.checked)} />带上文本</label>
      <p>附带内容卡中的输入文案。流程卡片里的操作指令始终保留。</p>
      <p>未携带的内容会留作待填输入，使用模板时再选择素材或文案。</p>
      {exporting && <p>发送数据包后，对方在画板右键「导入工作流数据包」，确认输入后添加到自己的画板。导入不会自动运行。</p>}
    </div>
  </ModalShell>;
}
