import { useEffect, useState } from "react";
import { ScanLine } from "lucide-react";
import { create } from "zustand";
import { getVideoAnalysisCapabilities, getVideoAnalysisProgress, quoteVideoAnalysis, startVideoAnalysis, formatVideoAnalysisDuration, hasVideoAnalysisPrice, type PricedVideoAnalysisQuote } from "../lib/videoAnalysis";
import { videoBatchScopeIds, type VideoBatchScope } from "../lib/videoBatchScope";
import { isPendingOriginal } from "../lib/pendingOriginalDeletion";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import { BcoinAmount } from "./BcoinAmount";
import { ModalShell } from "./ModalShell";

type Plan = {
  owner: string;
  videos: { assetId: string; quote: PricedVideoAnalysisQuote }[];
  exclusions: Map<string, number>;
};
type Task = {
  owner: string; label: string; total: number; done: number;
  stopping: boolean; running: boolean; message?: string;
};
const useBatch = create<{ task?: Task }>(() => ({}));

function updateTask(patch: Partial<Task>) {
  const task = useBatch.getState().task;
  if (task) useBatch.setState({ task: { ...task, ...patch } });
}

async function runBatch(plan: Plan, label: string) {
  if (useBatch.getState().task?.running) return;
  useBatch.setState({ task: { owner: plan.owner, label, total: plan.videos.length, done: 0, stopping: false, running: true } });
  let done = 0;
  let message: string | undefined;
  try {
    for (const { assetId, quote } of plan.videos) {
      if (useBatch.getState().task?.stopping) break;
      if (useStore.getState().cloudAuth?.user_id !== plan.owner) {
        message = "账号已切换，剩余视频未提交。";
        break;
      }
      if (isPendingOriginal(assetId)) {
        message = "视频原件已变更，请重新核对批量报价。";
        break;
      }
      let result = await startVideoAnalysis(assetId, plan.owner, quote);
      while (result?.status === "running" && useStore.getState().cloudAuth?.user_id === plan.owner) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const progress = await getVideoAnalysisProgress(assetId);
        if (!progress) break;
        result = progress;
      }
      if (result.status !== "completed") {
        message = "当前视频尚未完成，剩余视频未提交。请在视频预览查看进度。";
        break;
      }
      updateTask({ done: ++done });
    }
  } catch (reason) {
    message = userErrorMessage(reason, "当前视频尚未完成，剩余视频未提交。");
  } finally {
    updateTask({ running: false, message });
  }
}

export function VideoAnalysisBatchButton({ scope }: { scope: VideoBatchScope }) {
  const [open, setOpen] = useState(false);
  const owner = useStore(state => state.cloudAuth?.logged_in && state.cloudAuth.cloud_available ? state.cloudAuth.user_id : null);
  const task = useBatch(state => state.task?.owner === owner ? state.task : undefined);
  if (!owner) return null;
  return <>
    <button type="button" className="library-filter-trigger" title="批量画面分析" aria-label="批量画面分析" onClick={() => setOpen(true)}>
      <ScanLine size={14} aria-hidden="true"/>
    </button>
    {open && <VideoAnalysisBatchDialog key={JSON.stringify([owner, scope.folderId, scope.projectId])} owner={owner} scope={scope}
      task={task} onClose={() => setOpen(false)}/>}
  </>;
}

function VideoAnalysisBatchDialog({ owner, scope, task, onClose }: { owner: string; scope: VideoBatchScope; task?: Task; onClose: () => void }) {
  const { projectId, label, folderId } = scope;
  const [descendants, setDescendants] = useState(false);
  const [plan, setPlan] = useState<Plan>();
  const [error, setError] = useState("");
  const busy = useBatch(state => !!state.task?.running);
  useEffect(() => {
    if (task) return;
    let current = true;
    setPlan(undefined);
    setError("");
    void (async () => {
      const capability = await getVideoAnalysisCapabilities();
      if (!current) return;
      if (!capability.available) { setError("画面分析服务暂未开放。"); return; }
      const ids = await videoBatchScopeIds({ projectId, folderId, label }, descendants, () => current);
      const next: Plan = { owner, videos: [], exclusions: new Map() };
      const exclude = (reason: string) => next.exclusions.set(reason, (next.exclusions.get(reason) ?? 0) + 1);
      for (const assetId of ids) {
        if (!current) break;
        try {
          const quote = await quoteVideoAnalysis(assetId);
          if (quote.cloudPending) exclude("已有未完成任务");
          else if (!quote.chargeRequired) exclude("已有当前版本的画面描述");
          else if (hasVideoAnalysisPrice(quote)) next.videos.push({ assetId, quote });
          else exclude("报价暂不可用");
        } catch {
          exclude("原件或报价暂不可用");
        }
      }
      if (current) setPlan(next);
    })().catch(reason => { if (current) setError(userErrorMessage(reason, "无法读取当前范围的视频。")); });
    return () => { current = false; };
  }, [projectId, folderId, label, descendants, owner, task]);

  return <ModalShell title="批量画面分析" onClose={onClose} footer={task
    ? task.running
      ? <button type="button" className="app-button-secondary" disabled={task.stopping} onClick={() => updateTask({ stopping: true })}>
        {task.stopping ? "等待当前视频结束" : "停止剩余视频"}
      </button>
      : <button type="button" className="app-button-secondary" onClick={() => useBatch.setState({ task: undefined })}>选择新的范围</button>
    : <button type="button" className="app-button-primary" disabled={busy || !plan?.videos.length}
      onClick={() => { if (plan) void runBatch(plan, label); }}>开始分析</button>}>
    {task ? <div className="grid gap-3" role="status">
      <p>{task.label} · {task.done} / {task.total}</p>
      <progress className="w-full" max={task.total} value={task.done} aria-label="批量画面分析进度"/>
      {task.message && <p>{task.message}</p>}
    </div> : <div className="grid gap-3">
      <p>{label}</p>
      {folderId && <label className="flex items-center gap-2"><input type="checkbox" checked={descendants}
        onChange={event => { setPlan(undefined); setDescendants(event.target.checked); }}/>包含子文件夹</label>}
      {error ? <p role="status">{error}</p> : plan ? <>
        <p>本次可处理 {plan.videos.length} 个视频</p>
        {Array.from(plan.exclusions, ([reason, count]) => <p key={reason}>{reason}（{count} 个视频）</p>)}
        {!!plan.videos.length && <>
          <p>总时长 {formatVideoAnalysisDuration(plan.videos.reduce((sum, { quote }) => sum + quote.durationSeconds, 0))}
            {" · 共 "}{plan.videos.reduce((sum, { quote }) => sum + quote.segmentCount, 0)} 段</p>
          <p>预估上限 <BcoinAmount amount={plan.videos.reduce((sum, { quote }) => sum + quote.credits, 0)}/></p>
        </>}
      </> : <p role="status">正在核对时长和费用…</p>}
    </div>}
  </ModalShell>;
}
