import { useState, type ReactNode } from "react";
import { ChevronRight, History, Images, Play, Repeat2, RotateCcw, Rows3, Square } from "lucide-react";
import { workflowTitle, type WorkflowLoopItem, type WorkflowNode, type WorkflowRun } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode } from "../lib/types";
import { contentTableRows } from "../lib/contentTable";
import { CanvasImage } from "./CanvasImage";
import { TacticalSelect } from "./TacticalSelect";
import { WorkflowLoopStartSelect, loopItemDescription } from "./WorkflowLoopStartSelect";
import "./WorkflowLoopCard.css";

const modes = {
  images: { title: "逐张处理图片", icon: Images, empty: "拖入图片，或连接画板上的图片来源。" },
  rows: { title: "逐行处理内容", icon: Rows3, empty: "连接内容卡或表格，每次处理一行图文。" },
  count: { title: "重复执行", icon: Repeat2, empty: "" },
};
const statuses = { running: "处理中", waiting: "等待继续", stopped: "已停止", done: "已完成", failed: "未完成" };
type LoopMode = keyof typeof modes;
type OpenAgent = (id: string, conversationId?: string, entryKey?: string) => void;

interface HistoryProps {
  runs: WorkflowRun[]; assets: Asset[]; nodes: Map<string, WorkflowNode>; onOpenAgent: OpenAgent;
  graphById: Map<string, CanvasNode>; onOpenGeneration: (node: CanvasNode) => void;
}

function LoopHistory({ runs, assets, nodes, onOpenAgent, graphById, onOpenGeneration }: HistoryProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, select] = useState("");
  const selected = runs.find(run => run.id === selectedId) ?? runs[runs.length - 1];
  if (!selected?.loop || (runs.length === 1 && !selected.loop.completed.length)) return null;
  const loop = selected.loop;
  return <details className="workflow-loop-results" onToggle={event => setOpen(event.currentTarget.open)}
    onWheel={event => { if (!event.ctrlKey && !event.metaKey && open) event.stopPropagation(); }}>
    <summary><History size={14} />处理记录<small>{runs.length > 1 ? `${runs.length} 次循环` : `${loop.completed.length} 项`}</small><ChevronRight size={13} /></summary>
    {open && <>
      {runs.length > 1 && <TacticalSelect aria-label="选择循环记录" value={selected.id} onValueChange={select}>
        {runs.map((run, index) => <option key={run.id} value={run.id}>第 {index + 1} 次 · {statuses[run.status]} · {run.loop!.completed.length} 项结果</option>).reverse()}
      </TacticalSelect>}
      {!loop.completed.length && <small>本次还没有完成的项目</small>}
      {loop.completed.map((item, offset) => {
        const index = (loop.startIndex ?? 0) + offset;
        const input = loop.items?.[index];
        return <details key={`${selected.id}:${index}`}>
          <summary><ChevronRight size={12} />第 {index + 1} 项{input && <small>{loopItemDescription(input, assets)}</small>}</summary>
          {Object.entries(item.outputs).map(([id, outputs]) => {
            const source = nodes.get(id);
            if (!source) return null;
            if (source.kind === "agent") return <button key={id} onClick={() => onOpenAgent(id, item.steps[id]?.chatConversationId, `${selected.id}:${offset}`)}>{workflowTitle(source)} · 会话详情<ChevronRight size={12} /></button>;
            return <div key={id} className="loop-result-output">
              <strong>{workflowTitle(source)}</strong>
              {Object.values(outputs).map((value, i) => <div key={i}>{value.table
                ? <div className="workflow-table-result"><table><tbody>{contentTableRows(value.table).map((row, r) =>
                  <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table></div>
                : value.text && <p>{value.text}</p>}
                {value.nodeIds?.map(sessionId => {
                  const session = graphById.get(sessionId);
                  return session?.kind === "prompt" && session.hiddenAt == null
                    ? <button key={sessionId} onClick={() => onOpenGeneration(session)}>查看生成会话<ChevronRight size={12} /></button>
                    : <small key={sessionId}>生成会话已移除</small>;
                })}
                {value.assetIds?.map((assetId, j) => {
                  const asset = assets.find(asset => asset.id === assetId);
                  return asset?.thumb_path || asset?.store_path ? <CanvasImage key={j} alt={asset.name} path={asset.store_path} thumbPath={asset.thumb_path} sourceWidth={asset.width} sourceHeight={asset.height} /> : <span key={j}>图片不可用</span>;
                })}{value.summary && <p>{value.summary}</p>}</div>)}
            </div>;
          })}
        </details>;
      })}
    </>}
  </details>;
}

export function WorkflowLoopCard({ node, items, notice, busy, run, bindings, onMode, onCount, onStartItem, ...history }: HistoryProps & {
  node: WorkflowNode; items?: WorkflowLoopItem[]; notice: string; busy: boolean; run?: WorkflowRun; bindings: ReactNode;
  onMode: (mode: LoopMode) => void; onCount: (count: number) => void; onStartItem: (start: number) => void;
}) {
  const mode = node.loopMode ?? "images", ModeIcon = modes[mode].icon;
  const loop = run?.loop?.nodeId === node.id ? run.loop : undefined;
  const start = node.loopStartItem ?? 1;
  const [countDraft, setCountDraft] = useState<string | null>(null);
  const total = loop?.items ? loop.items.length - (loop.startIndex ?? 0) : 0;
  const current = loop?.items?.[loop.index];
  const pending = loop && run?.status === "waiting" && Object.values(run.steps).some(step => step.status === "failed");
  const changed = loop?.items && items && JSON.stringify(loop.items) !== JSON.stringify(items);
  const empty = !node.inputs[mode === "rows" ? "text" : "image"]?.length;
  return <section className="workflow-loop" aria-label="循环设置">
    <div className="loop-mode"><ModeIcon size={20} strokeWidth={1.5} aria-hidden="true" />
      <TacticalSelect aria-label="循环方式" disabled={busy} value={mode} onValueChange={value => onMode(value as LoopMode)}>
        {Object.entries(modes).map(([key, item]) => <option key={key} value={key}>{item.title}</option>)}
      </TacticalSelect>
    </div>
    {bindings}
    {mode === "count" && <label className="loop-count">重复次数 <input aria-label="循环次数" type="number" min={1} max={100} step={1} disabled={busy}
      value={countDraft ?? node.loopCount ?? 1} onChange={event => {
        setCountDraft(event.target.value);
        const n = event.target.valueAsNumber;
        if (Number.isInteger(n) && n >= 1 && n <= 100) onCount(n);
      }} onBlur={() => setCountDraft(null)} /> 次</label>}
    <WorkflowLoopStartSelect id={node.id} items={items ?? []} assets={history.assets} value={start} rounds={mode === "count"} disabled={busy} notice={empty && mode !== "count" ? modes[mode].empty : notice} onChange={onStartItem} />
    {!!items && start > items.length && <p className="loop-note">原起始项已超出输入范围，请重新选择。</p>}
    {changed && <p className="loop-note">输入已更新为 {items.length} 项。本次记录保留启动时的 {loop.items!.length} 项。</p>}
    {loop && run && <div className="loop-progress" role="status">
      <div><strong>{pending ? "有步骤待重试" : run.status === "done" ? "上次循环" : statuses[run.status]}</strong>{loop.items && <span>已完成 <b>{loop.completed.length}</b> / {total} 项</span>}</div>
      {total > 0 && <progress aria-label="本次循环进度" value={loop.completed.length} max={total} />}
      {!loop.items ? <small>等待上游准备输入</small> : current && loop.completed.length < total && <small>当前第 {loop.index + 1} 项 · {loopItemDescription(current, history.assets)}</small>}
    </div>}
    <LoopHistory {...history} />
  </section>;
}

export function WorkflowLoopActions({ run, busy, invalid, retryBlocked, restartBlocked, onStart, onStop, onContinue, onRetry, onRestart }: {
  run?: WorkflowRun; busy: boolean; invalid: boolean; retryBlocked: boolean; restartBlocked: boolean;
  onStart: () => void; onStop: () => void; onContinue: () => void; onRetry: () => void; onRestart: () => void;
}) {
  const loop = run?.loop;
  const restart = run?.status === "stopped" && loop && (!loop.items || loop.completed.length < loop.items.length - (loop.startIndex ?? 0));
  const failedStep = run?.status === "waiting" && Object.values(run.steps).some(step => step.status === "failed");
  return <div className="loop-actions">
    {run?.status === "running" || run?.status === "waiting" ? <>
      <button aria-label="停止工作流" onClick={onStop}><Square size={12} />停止循环</button>
      {run.status === "waiting" && <button className="loop-main-action" disabled={!!failedStep && retryBlocked} onClick={failedStep ? onRetry : onContinue}><Play size={13} />{failedStep ? "重试失败步骤" : "继续循环"}</button>}
    </> : <>
      <button className={restart ? undefined : "loop-main-action"} disabled={busy || invalid} onClick={onStart}><Play size={13} />{run ? "开始新循环" : "开始循环"}</button>
      {restart && <button className="loop-main-action" disabled={busy || restartBlocked} title="保留已完成结果，使用本次循环的原始输入" onClick={onRestart}><RotateCcw size={13} />从第 {loop.index + 1} 项继续</button>}
    </>}
  </div>;
}
