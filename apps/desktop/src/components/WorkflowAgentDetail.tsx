import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { workflowRuns, type WorkflowAgentEvent, type WorkflowValue } from "../lib/canvasWorkflow";
import { contentTableRows } from "../lib/contentTable";
import type { Asset, CanvasNode } from "../lib/types";
import { ProjectInspectorShell } from "./ProjectInspectorShell";
import { ModalShell } from "./ModalShell";
import "./WorkflowAgentDetail.css";

const statusLabels: Record<string, string> = { pending: "等待执行", running: "运行中", waiting: "等待继续", done: "已完成", failed: "失败", stopped: "已停止" };
const valueText = (value: WorkflowValue) => value.table ? contentTableRows(value.table).map(row => row.join(" · ")).join("\n") : value.text;

export function WorkflowAgentDetail({ projectId, nodeId, graphNodes, onOpenGeneration, onClose }: {
  projectId: string; nodeId: string; graphNodes: CanvasNode[]; onOpenGeneration: (node: CanvasNode) => void; onClose: () => void;
}) {
  const controller = useMemo(() => canvasWorkflowController(projectId), [projectId]);
  const [, redraw] = useState(0);
  const [selection, setSelection] = useState("latest");
  const [journal, setJournal] = useState<{ requestId: string; events: WorkflowAgentEvent[] } | null>(null);
  const [progressError, setProgressError] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [preview, setPreview] = useState<Asset | null>(null);
  useEffect(() => controller.subscribe(() => redraw(value => value + 1)), [controller]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]')) { event.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const entries = workflowRuns(controller.document).flatMap((run, runIndex) => {
    const previous = run.loop?.completed.flatMap((item, index) => item.steps[nodeId] ? [{
      key: `${run.id}:${index}`, step: item.steps[nodeId], outputs: item.outputs[nodeId], status: "done",
      label: `运行 ${runIndex + 1} · 第 ${(run.loop!.startIndex ?? 0) + index + 1} 轮`,
    }] : []) ?? [];
    const step = run.steps[nodeId];
    if (step && !(run.loop && run.status === "done" && previous.length)) previous.push({ key: `${run.id}:current`, step,
      outputs: step.agentOutputs ?? {},
      status: step.status === "done" ? "done" : run.status === "stopped" ? "stopped" : step.status,
      label: `运行 ${runIndex + 1}${run.loop ? ` · 第 ${run.loop.index + 1} 轮` : ""}` });
    return previous;
  });
  const entry = (selection === "latest" ? entries[entries.length - 1] : entries.find(entry => entry.key === selection)) ?? entries[entries.length - 1];
  const step = entry?.step;
  const requestId = step?.localDsRequestId;
  const active = entry?.status === "running" || entry?.status === "waiting";
  useEffect(() => {
    setJournal(null); setProgressError("");
    if (!requestId || step?.localAgentTransport !== "codex-cli") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api.agentDsWorkflowProgress(requestId);
        if (!cancelled) { setJournal({ requestId, events: result }); setProgressError(""); }
      } catch { if (!cancelled) setProgressError("过程记录暂时无法读取，任务仍会继续。"); }
      if (!cancelled && active) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [requestId, step?.localAgentTransport, active]);
  const outputs = entry?.outputs ?? {};
  const inputIds = step?.agentInput?.assetIds ?? [];
  const outputIds = [...new Set(Object.values(outputs).flatMap(value => value.assetIds ?? []))];
  const assetKey = JSON.stringify([...new Set([...inputIds, ...outputIds])]);
  useEffect(() => {
    let cancelled = false;
    setAssets([]);
    void api.getAssetsByIds(JSON.parse(assetKey)).then(assets => { if (!cancelled) setAssets(assets); }).catch(() => {});
    return () => { cancelled = true; };
  }, [assetKey]);
  const pictures = (ids: string[]) => <div className="workflow-agent-detail-images">{ids.map((id, index) => {
    const asset = assets.find(asset => asset.id === id);
    return <button key={`${id}:${index}`} type="button" disabled={!asset?.store_path} onClick={() => asset && setPreview(asset)} aria-label={`查看图片 ${index + 1}`}>
      {asset?.store_path ? <img src={convertFileSrc(asset.thumb_path || asset.store_path)} alt={`图片 ${index + 1}`} /> : <span>图片 {index + 1} 暂不可用</span>}
      <small>图片 {index + 1}</small>
    </button>;
  })}</div>;
  const events = journal && journal.requestId === requestId ? journal.events : [];
  const progress = [...(step?.agentProgress ?? []).map((item, index) => ({ ...item, id: `stage:${index}`, status: "", kind: "stage" })), ...events]
    .sort((a, b) => a.at - b.at);
  const sources: Record<string, unknown> = (() => { try { return JSON.parse(step?.agentInput?.source ?? "{}"); } catch { return {}; } })();
  const generations = Object.values(step?.localDsGenerations ?? {});
  const sessionIds = [...new Set([...(outputs.image?.nodeIds ?? outputs.session?.nodeIds ?? []), ...generations.flatMap(call => call.response?.submitted ? [call.response.submitted.sessionNodeId] : [])])];
  return <ProjectInspectorShell anchorNodeId={nodeId} onClose={onClose} header={{ kind: "agent", title: "Agent 卡片详情", closeLabel: "关闭项目详情", detail: `${step?.localAgentTransport === "codex-cli" ? "Codex CLI" : step?.agentRunId ? "Cloud DSH" : "Agent DS"} · ${statusLabels[entry?.status ?? "pending"]}`, running: entry?.status === "running" }}>
    <div className="workflow-agent-detail" data-agent-detail={nodeId}>
      {entries.length > 1 && <label>执行记录<select aria-label="Agent 执行记录" value={selection} onChange={event => setSelection(event.target.value)}>
        <option value="latest">最新执行</option>{entries.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
      </select></label>}
      <section className="workflow-agent-input"><h3>输入</h3>
        <p>{step?.agentInput?.prompt || (active || step?.status === "pending" ? "正在准备本次输入。" : "此历史任务未保存输入快照。")}</p>
        {Object.entries(sources).filter(([key]) => key !== "__outputTargets").map(([key, value]) => <div key={key}><h4>{key}</h4><p>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</p></div>)}
        {pictures(inputIds)}
      </section>
      {step?.agentInput?.visualProfile && <section aria-label="本次视觉规范"><h3>视觉规范 · {step.agentInput.visualProfile.name} · v{step.agentInput.visualProfile.version}</h3>
        <small>本次执行使用的只读规则；本次明确要求优先。</small>
        <p>{step.agentInput.visualProfile.summary}</p>
        {(["must", "prefer", "avoid"] as const).map(polarity => <div key={polarity}><h4>{{ must: "必须保持", prefer: "尽量遵循", avoid: "必须避免" }[polarity]}</h4>
          {step.agentInput!.visualProfile!.rules.filter(rule => rule.polarity === polarity).map((rule, index) => <p key={index}>{rule.category}：{rule.value}</p>)}
        </div>)}
      </section>}
      <section><h3>执行过程</h3><small>公开过程说明与工具状态</small>
        {progress.length ? <ol className="workflow-agent-events">{progress.map((event, index) => <li key={`${event.id}:${index}`} data-event-kind={event.kind}>
          <time>{new Date(event.at).toLocaleTimeString("zh-CN")}</time><p>{event.text}</p>{event.status && <small>{event.status === "running" && !active ? "未记录完成" : statusLabels[event.status]}</small>}
        </li>)}</ol> : <p>{step?.detail || "等待 Agent 返回过程记录。"}</p>}
        {step?.localAgentTransport !== "codex-cli" && <small>此通道提供任务阶段与生图记录，尚未提供逐条执行消息。</small>}
        {progressError && <p role="status">{progressError}</p>}
        {generations.map(call => <details key={call.request.id}><summary>生成任务 · {call.response?.error ? "失败" : call.response?.submitted ? "已提交" : call.response ? "已完成" : "处理中"}</summary>
          <p>{call.request.prompt}</p>{call.request.ratio && <p>比例：{call.request.ratio}</p>}{call.response?.error && <p role="alert">{call.response.error}</p>}
        </details>)}
        {step?.error && <p role="alert">{step.error}</p>}
      </section>
      <section><h3>输出</h3>
        {Object.entries(outputs).filter(([, value]) => value.type === "text").map(([port, value]) => <p key={port}>{valueText(value)}</p>)}
        {pictures(outputIds)}
        {!Object.keys(outputs).length && <p>{active ? "结果将在完成后显示。" : "本次没有已交付结果。"}</p>}
        {sessionIds.map((id, index) => { const card = graphNodes.find(node => node.id === id && node.hiddenAt == null); return <button className="workflow-agent-session" key={id} disabled={!card} onClick={() => { if (card) { onClose(); onOpenGeneration(card); } }}>查看生成会话 {index + 1}</button>; })}
      </section>
    </div>
    {preview && <ModalShell title="Agent 图片" width="lg" onClose={() => setPreview(null)}><img className="workflow-agent-detail-preview" src={convertFileSrc(preview.store_path!)} alt="Agent 图片" /></ModalShell>}
  </ProjectInspectorShell>;
}
