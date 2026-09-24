import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { emit } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { canvasInputValue } from "../lib/canvasSessionOutputs";
import { readCanvasNote } from "../lib/canvasNotes";
import { workflowBindingKey, workflowOutputs, workflowTitle, type WorkflowInput } from "../lib/canvasWorkflow";
import { captureWorkflowTemplate, instantiateWorkflowTemplate, parseWorkflowTemplate, reconfigureTemplateInstance, TEMPLATE_RATIOS, TEMPLATE_MAX_BYTES, type WorkflowTemplate } from "../lib/workflowTemplates";
import { materializeTemplateContent } from "../lib/workflowTemplateContent";
import type { CanvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import type { CanvasNode } from "../lib/types";
import { ModalShell } from "./ModalShell";

interface Props {
  controller: CanvasWorkflowController; selectedIds: Set<string>; graphNodes: CanvasNode[]; provider: string;
  instanceRoot?: string; ensureMaterialized: () => Promise<unknown>; onClose: () => void;
  onLocate: (id: string) => void;
}
export function WorkflowTemplateLibrary({ controller, selectedIds, graphNodes, provider, instanceRoot, ensureMaterialized, onClose, onLocate }: Props) {
  const instance = controller.document.nodes.find(node => node.id === instanceRoot)?.templateInstance;
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]), [search, setSearch] = useState("");
  const [active, setActive] = useState<WorkflowTemplate | null>(instance?.template ?? null);
  const [draft, setDraft] = useState<WorkflowTemplate | null>(null);
  const [bindings, setBindings] = useState<Record<string, WorkflowInput>>(instance?.bindings ?? {});
  const [values, setValues] = useState<Record<string, string>>(instance?.values ?? {});
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const perform = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const load = async () => setTemplates(await api.workflowTemplatesList());
  useEffect(() => { if (!instanceRoot) void load().catch(reason => setError(String(reason))); }, [instanceRoot]);
  const select = (template: WorkflowTemplate) => { setActive(template); setDraft(null); setBindings({}); setValues({}); setError(""); setDeleteId(null); };
  const options: { label: string; type: string; input: WorkflowInput }[] = [];
  for (const [index, node] of graphNodes.filter(node => node.hiddenAt == null).entries()) {
    if (node.kind === "asset" && node.assetId) options.push({ label: `画板图片 ${index + 1}`, type: "image", input: { assetId: node.assetId, assetNodeId: node.id } });
    if (node.kind === "note") for (const [i, cell] of readCanvasNote(node).cells.flat().entries()) {
      const value = canvasInputValue(node, cell.id!, graphNodes);
      if (value) options.push({ label: `${readCanvasNote(node).title || "内容卡"} · 第 ${i + 1} 格${value.type === "text" ? ` · ${value.text?.slice(0, 28) ?? "文本"}` : " · 图片"}`, type: value.type, input: { canvasNodeId: node.id, cellId: cell.id } });
    }
  }
  for (const node of controller.document.nodes.filter(node => !instance?.nodeIds.includes(node.id))) for (const port of workflowOutputs(node)) if (port.type === "text" || port.type === "image") options.push({ label: `${workflowTitle(node)} · ${port.label}`, type: port.type, input: { nodeId: node.id, portId: port.id } });
  const uniqueOptions = options.filter((option, index) => options.findIndex(other => other.type === option.type && workflowBindingKey(other.input) === workflowBindingKey(option.input)) === index);
  const configure = active && <div className="workflow-template-config">
    <h3>{active.name} <small>v{active.revision}</small></h3><p>{active.description}</p>
    <p>{active.plan.nodes.length - 1} 个步骤 · {active.inputs.length} 个输入 · {active.outputs.length} 个公开输出</p>
    {active.inputs.map(input => {
      const available = uniqueOptions.filter(option => option.type === input.type);
      const current = bindings[input.id] ? workflowBindingKey(bindings[input.id]) : "";
      return <label key={input.id}>{input.label} · {input.type === "image" ? "图片" : "文本"}
        <select aria-label={input.label} value={current} onChange={event => setBindings(old => { const next = { ...old }, source = available.find(option => workflowBindingKey(option.input) === event.target.value); if (source) next[input.id] = source.input; else delete next[input.id]; return next; })}>
          <option value="">{input.content ? "使用模板自带内容" : "请选择当前画板的来源"}</option>
          {current && !available.some(option => workflowBindingKey(option.input) === current) && <option value={current}>原来源已失效，请重新选择</option>}
          {available.map((option, i) => <option key={i} value={workflowBindingKey(option.input)}>{option.label}</option>)}
        </select>
        {input.content && !current && <small>{input.type === "text" ? input.content.text?.slice(0, 100) : `${input.content.images?.length ?? 0} 张自带图片`}</small>}
      </label>;
    })}
    {active.parameters.map(param => <label key={param.id}>{param.label}{param.field === "ratio"
      ? <select aria-label={param.label} value={values[param.id] ?? param.defaultValue} onChange={event => setValues({ ...values, [param.id]: event.target.value })}>{TEMPLATE_RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio || "自动比例"}</option>)}</select>
      : <textarea aria-label={param.label} maxLength={2000} value={values[param.id] ?? param.defaultValue} onChange={event => setValues({ ...values, [param.id]: event.target.value })} />}</label>)}
    <details><summary>查看内部步骤与输出</summary><ol>{active.plan.nodes.filter(node => node.kind !== "trigger").map(node => <li key={node.id}>{{ instruction: "指令", agent: "文本改写", generation: "生成", skill: "技能", "visual-profile": "视觉规范", trigger: "触发器" }[node.kind]} · {node.prompt?.replace(/\{\{[^}]+\}\}/g, "【输入内容】").slice(0, 180)}</li>)}</ol>
      <p>公开输出：{active.outputs.map(output => output.label).join("、")}</p></details>
    <button disabled={busy || !!controller.error} onClick={() => void perform(async () => {
      for (const input of active.inputs) if (!(input.content && !bindings[input.id]) && !uniqueOptions.some(option => option.type === input.type && workflowBindingKey(option.input) === workflowBindingKey(bindings[input.id] ?? {}))) throw new Error(`请重新选择「${input.label}」`);
      await ensureMaterialized();
      if (instanceRoot) {
        const next = reconfigureTemplateInstance(controller.document.nodes, instanceRoot, bindings, values, id => controller.isLocked(id));
        await controller.edit(next); onClose(); onLocate(instanceRoot);
      } else {
        const x = Math.max(0, ...controller.document.nodes.map(node => node.x + 400), ...graphNodes.filter(node => node.hiddenAt == null).map(node => node.x + node.width + 40));
        const prepared = { ...bindings };
        // Validate the whole graph/parameters before writing any carried content.
        const placeholders = Object.fromEntries(active.inputs.map(input => [input.id, prepared[input.id] ?? { canvasNodeId: input.id, cellId: "template-content" }]));
        instantiateWorkflowTemplate(active, placeholders, values, provider, controller.document.nodes, x + 380, 80);
        try { await materializeTemplateContent(active, prepared, controller.projectId, x, 80); }
        finally { setBindings({ ...prepared }); await emit("creative://changed", { projectId: controller.projectId }); }
        const nodes = instantiateWorkflowTemplate(active, prepared, values, provider, controller.document.nodes, x + (active.inputs.some(input => input.content) ? 380 : 0), 80);
        await controller.edit([...controller.document.nodes, ...nodes]); onClose(); onLocate(nodes[0].id);
      }
    })}>{instanceRoot ? "保存子流程参数" : "添加子流程到画板"}</button>
    <p className="workflow-hint">添加和配置不会自动运行。内部步骤可单独编辑；手动编辑后统一参数配置会停止覆盖这些步骤。</p>
  </div>;
  return <ModalShell title={instanceRoot ? "配置子流程" : "工作流模板库"} width="lg" preventClose={busy} onClose={onClose}
    panelProps={{ onPointerDown: event => event.stopPropagation(), onWheel: event => event.stopPropagation(), onKeyDown: event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); } }}>
    <div className="workflow-template-library">
      {error && <p role="alert" className="workflow-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      {instanceRoot ? configure : <>
        <div className="workflow-template-actions"><input aria-label="搜索工作流模板" placeholder="搜索名称或说明" value={search} onChange={event => setSearch(event.target.value)} />
          <label className="workflow-template-import">导入流程文件<input type="file" accept=".json" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = "";
            if (file) void perform(async () => { if (file.size > TEMPLATE_MAX_BYTES) throw new Error("模板文件超过 32 MB"); const imported = parseWorkflowTemplate(await file.text());
              const saved = await api.workflowTemplateSave({ ...imported, id: crypto.randomUUID(), revision: 0 }); await load(); select(saved); setNotice("已导入模板，请配置当前画板的输入素材。"); });
          }} /></label>
        </div>
        <div className="workflow-template-columns"><aside>
          {!templates.length && <p>还没有模板。在画板中框选步骤，右键「存为模板」，或导入他人分享的流程文件。</p>}
          {templates.filter(template => `${template.name} ${template.description}`.toLowerCase().includes(search.toLowerCase())).map(template => <button key={template.id} aria-pressed={active?.id === template.id} onClick={() => select(template)}>{template.name} <small>v{template.revision}</small></button>)}
        </aside><main>{draft ? <section>
          <h3>{draft.revision ? "更新模板版本" : "创建流程模板"}</h3>
          <label>模板名称<input aria-label="模板名称" maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>说明<textarea aria-label="模板说明" maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
          <h4>公开输入</h4>{draft.inputs.map((input, index) => <label key={input.id}>{input.type === "image" ? "图片" : "文本"}输入名称<input aria-label={`输入名称 ${index + 1}`} value={input.label} onChange={event => setDraft({ ...draft, inputs: draft.inputs.map(other => other.id === input.id ? { ...other, label: event.target.value } : other) })} /></label>)}
          <h4>公开参数</h4>{draft.plan.nodes.filter(node => node.kind !== "trigger").flatMap((node, index) => ([...(node.kind !== "instruction" || node.action === "describe" ? ["suffix"] : []), ...(node.kind === "generation" ? ["ratio"] : [])] as ("suffix" | "ratio")[]).map(field => {
            const param = draft.parameters.find(param => param.node === node.id && param.field === field);
            const id = param?.id ?? `param_${node.id}_${field}`;
            const title = `步骤 ${index + 1} · ${field === "ratio" ? "画面比例" : "附加要求"}`;
            return <div key={id}><label><input type="checkbox" checked={!!param} onChange={event => setDraft({ ...draft, parameters: event.target.checked ? [...draft.parameters, { id, label: title, node: node.id, field, defaultValue: field === "ratio" ? node.ratio ?? "" : "" }] : draft.parameters.filter(param => param.id !== id) })} />{title}</label>
              {param && <><input aria-label={`${title}的名称`} value={param.label} onChange={event => setDraft({ ...draft, parameters: draft.parameters.map(p => p.id === id ? { ...p, label: event.target.value } : p) })} />
                <label>默认值{field === "ratio" ? <select aria-label={`${title}的默认值`} value={param.defaultValue} onChange={event => setDraft({ ...draft, parameters: draft.parameters.map(p => p.id === id ? { ...p, defaultValue: event.target.value } : p) })}>{TEMPLATE_RATIOS.map(ratio => <option key={ratio} value={ratio}>{ratio || "自动比例"}</option>)}</select>
                  : <textarea aria-label={`${title}的默认值`} maxLength={2000} value={param.defaultValue} onChange={event => setDraft({ ...draft, parameters: draft.parameters.map(p => p.id === id ? { ...p, defaultValue: event.target.value } : p) })} />}</label></>}</div>;
          }))}
          <h4>公开输出</h4>{draft.outputs.map((output, index) => <label key={output.id}>输出名称<input aria-label={`输出名称 ${index + 1}`} value={output.label} onChange={event => setDraft({ ...draft, outputs: draft.outputs.map(other => other.id === output.id ? { ...other, label: event.target.value } : other) })} /></label>)}
          <button disabled={busy} onClick={() => void perform(async () => { const checked = parseWorkflowTemplate(JSON.stringify({ ...draft, plan: { ...draft.plan, summary: draft.name } })); const saved = await api.workflowTemplateSave(checked); await load(); select(saved); setNotice("模板已保存，已有实例保持原版本。"); })}>保存模板</button>
          <button onClick={() => setDraft(null)}>取消编辑</button>
        </section> : <>{configure}{active && <div className="workflow-template-actions">
          <button disabled={busy} onClick={() => setDraft(structuredClone(active))}>编辑模板</button>
          {selectedIds.size > 0 && <button disabled={busy} onClick={() => { try { const next = captureWorkflowTemplate(controller.document.nodes, selectedIds, active.name); setDraft({ ...next, id: active.id, revision: active.revision, description: active.description }); } catch (reason) { setError(String(reason)); } }}>用当前画板选区更新步骤</button>}
          <button disabled={busy} onClick={() => void perform(async () => { const path = await save({ defaultPath: `${active.name.replace(/[<>:"/\\|?*]/g, "_")}.bbworkflow.json`, filters: [{ name: "Bowerbird 工作流", extensions: ["json"] }] }); if (path) { await api.workflowTemplateExport(active.id, path); setNotice("流程文件已导出。接收者在模板库导入后选择自己的输入素材。"); } })}>导出分享文件</button>
          {deleteId === active.id ? <><span>仅删除库中模板，保留已有实例。</span><button disabled={busy} onClick={() => void perform(async () => { await api.workflowTemplateDelete(active.id, active.revision); setActive(null); setDeleteId(null); await load(); })}>确认删除模板</button><button onClick={() => setDeleteId(null)}>取消</button></> : <button onClick={() => setDeleteId(active.id)}>删除模板</button>}
        </div>}</>}</main></div>
      </>}
    </div>
  </ModalShell>;
}
