import { useState } from "react";
import type { WorkflowNode, WorkflowPromptReference } from "../lib/canvasWorkflow";
import type { CanvasNode } from "../lib/types";
import type { WorkflowPlannerRuntime } from "../lib/workflowPlannerRuntime";
import { notifyError } from "../lib/notify";
import { WorkflowPromptEditor } from "./WorkflowPromptEditor";
import { canResumeWorkflowPlanning } from "../lib/workflowPlanner";

export function WorkflowPlannerCard({ node, nodes, graphNodes, runtime, onChange, onLocate }: {
  node: WorkflowNode; nodes: WorkflowNode[]; graphNodes: CanvasNode[]; runtime: WorkflowPlannerRuntime;
  onChange: (prompt: string, references: WorkflowPromptReference[]) => void; onLocate: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const planning = node.planning, waiting = planning?.status === "waiting";
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (error) { notifyError(error, "工作流编排未完成"); } finally { setBusy(false); }
  };
  return <section className="workflow-planner" aria-label="工作流编排助手">
    <p className="workflow-hint workflow-planner-inputs">编排素材（可选）</p>
    <WorkflowPromptEditor node={node} nodes={nodes} graphNodes={graphNodes} disabled={waiting || busy} onChange={onChange} />
    <p className="workflow-hint">按 @ 引用接入的文本和图片，说明各自用途。搭建完成后，点击新流程的触发器运行。</p>
    {!import.meta.env.DEV && <p className="workflow-waiting">工作流助手目前仅在开发版连接本机 DSH。</p>}
    {planning?.summary && <p className="workflow-planner-summary" style={{ whiteSpace: "pre-wrap" }}>{planning.summary}</p>}
    {planning?.error && <p className={planning.status === "failed" ? "workflow-error" : "workflow-waiting"} role="status">{planning.error}</p>}
    <footer>
      <span>{waiting ? "等待编排结果" : planning?.status === "applied" ? "流程已搭建 · 未自动运行" : planning?.status === "undone" ? "已撤回流程" : "本机 DSH · 开发版"}</span>
      {waiting ? <>
        <button disabled={busy} onClick={() => void act(() => runtime.collect(node.id))}>取回编排</button>
        <button disabled={busy} onClick={() => void act(() => runtime.cancel(node.id))}>取消等待</button>
      </> : <button disabled={busy || !import.meta.env.DEV || !node.prompt.trim()} onClick={() => void act(() => runtime.start(node.id))}>{busy ? "正在提交…" : planning?.status === "applied" ? "另建流程" : "编排工作流"}</button>}
    </footer>
    {canResumeWorkflowPlanning(planning) && <button disabled={busy} onClick={() => void act(() => runtime.collect(node.id))}>取回修订后的原请求</button>}
    {planning?.status === "applied" && <div className="workflow-planner-actions">
      <button onClick={onLocate}>定位新流程</button>
      <button disabled={busy} title="只撤回未编辑、未运行且未接入其他卡片的流程" onClick={() => void act(() => runtime.undo(node.id))}>撤回此次编排</button>
    </div>}
  </section>;
}
