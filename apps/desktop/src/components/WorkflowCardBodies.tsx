import { TacticalSelect } from "./TacticalSelect";
import { completedCanvasSessions } from "../lib/canvasSessionOutputs";
import { useStore } from "../store";
import { invalidateWorkflow, type WorkflowNode } from "../lib/canvasWorkflow";
import { ProviderSelect } from "./creation/ProviderSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { WorkflowTriggerSchedule } from "./WorkflowTriggerSchedule";
import { workflowTriggerMode } from "../lib/workflowTriggerSchedule";
import { TRIGGER_MODES, WorkflowLayerProps } from "./workflowLayerShared";
import type { WorkflowLayerState } from "./useWorkflowLayerState";

type CardBodyProps = { node: WorkflowNode; busy: boolean };

export function WorkflowInstructionSettings({ node, busy, layer }: CardBodyProps & { layer: WorkflowLayerState }) {
  const { controller, handle, edit } = layer;
  return <TacticalSelect aria-label="指令功能" disabled={busy} value={node.action} onValueChange={value => {
    const action = value as WorkflowNode["action"];
    const nodes = invalidateWorkflow(controller.document.nodes, node.id).map(candidate => candidate.id === node.id ? { ...candidate, action, outputPorts: [] } : { ...candidate,
      inputs: Object.fromEntries(Object.entries(candidate.inputs).map(([port, bindings]) => [port, bindings.filter(binding => binding.nodeId !== node.id)])) });
    handle(edit(nodes));
  }}><option value="describe">反推</option><option value="reuse">复用生成提示词</option><option value="layers">分层编辑</option></TacticalSelect>;
}

export function WorkflowProfileSettings({ node, busy, layer }: CardBodyProps & { layer: WorkflowLayerState }) {
  const { patch, profiles } = layer;
  return <TacticalSelect aria-label="视觉规范来源" disabled={busy} value={node.profileId ?? ""} onValueChange={value => patch(node.id, { profileId: value || undefined, profileCache: undefined, inputs: {}, prompt: "" })}>
    <option value="">从图片 / 文字提炼</option>
    {node.profileId && !profiles.some(p => p.id === node.profileId) && <option value={node.profileId}>已选规范不可用</option>}
    {profiles.map(p => <option key={p.id} value={p.id}>{p.name} · v{p.version}</option>)}
  </TacticalSelect>;
}

export function WorkflowGenerationSettings({ node, busy, layer, videoCard, videoControls }: CardBodyProps & { layer: WorkflowLayerState; videoCard: boolean; videoControls: React.ReactNode }) {
  const { patch, state } = layer;
  return <div className="workflow-media-settings">
    {!videoCard && <div className="workflow-generation-parameters" role="toolbar" aria-label="生成参数" onPointerDown={event => event.stopPropagation()}>
      <fieldset disabled={busy}><RatioSelect value={node.ratio} onChange={ratio => patch(node.id, { ratio })} />
        <ProviderSelect environmentInHeader value={node.provider} onChange={provider => patch(node.id, { provider })} codexHealth={state.codexHealth} dreaminaHealth={state.dreaminaHealth}
          cloudAuth={state.cloudAuth} cloudEntitlement={state.cloudEntitlement} menuClassName="canvas-tactical-model-menu" /></fieldset>
    </div>}
    {videoCard && <fieldset className="workflow-video-parameters workflow-video-controls" aria-label="视频参数" disabled={busy} onPointerDown={event => event.stopPropagation()}>
      {videoControls}
    </fieldset>}
  </div>;
}

export function WorkflowTriggerSettings({ node, busy, patch, graphNodes }: CardBodyProps & { patch: WorkflowLayerState["patch"]; graphNodes: WorkflowLayerProps["graphNodes"] }) {
  const triggerMode = workflowTriggerMode(node);
  return <>
    <div className="workflow-trigger-mode" onPointerDown={event => event.stopPropagation()}>
      <svg className="workflow-trigger-circuit" width="40" height="24" viewBox="0 0 40 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M0 15h9m21 0h10M13 13l13-9" /><circle cx="11" cy="15" r="2" /><circle cx="28" cy="15" r="2" />
        <path className="workflow-trigger-contact" d="M13 15h13" />
      </svg>
      <TacticalSelect aria-label="触发方式" value={triggerMode} disabled={busy} onValueChange={value => {
        const id = value as NonNullable<WorkflowNode["triggerMode"]>;
        if (triggerMode === id) return;
        patch(node.id, { triggerMode: id, triggerSchedule: undefined,
          ...(id === "completion" ? { completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(node.inputs.completion ?? [], graphNodes, useStore.getState().genJobs)])] } : {}) }, false);
      }}>{TRIGGER_MODES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</TacticalSelect>
    </div>
    {(triggerMode === "daily" || triggerMode === "once") && <WorkflowTriggerSchedule key={triggerMode} mode={triggerMode} schedule={node.triggerSchedule} disabled={busy}
      onChange={triggerSchedule => patch(node.id, { triggerMode, triggerSchedule }, false)} />}
    {triggerMode === "completion" && <label className="workflow-trigger-count" title="上游成功完成后扣 1 次；为 0 时停止完成触发。">剩余
      <input aria-label="剩余触发次数" type="number" min={0} max={9999} step={1} value={node.triggerCount ?? 0} disabled={busy}
        onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 0 && value <= 9999) patch(node.id, { triggerCount: value,
          ...(value > (node.triggerCount ?? 0) ? { completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(node.inputs.completion ?? [], graphNodes, useStore.getState().genJobs)])] } : {}) }, false); }} />
      <span>次</span>
    </label>}
  </>;
}
