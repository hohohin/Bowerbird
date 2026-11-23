import { useEffect, useState } from "react";
import { Captions } from "lucide-react";
import { create } from "zustand";
import { videoBatchScopeIds, type VideoBatchScope } from "../lib/videoBatchScope";
import { isPendingOriginal } from "../lib/pendingOriginalDeletion";
import { userErrorMessage } from "../lib/userError";
import { getVideoTranscript, quoteVideoTranscript, startVideoTranscript, useVideoTranscriptPrice, type VideoTranscript, type VideoTranscriptQuote } from "../lib/videoTranscript";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import { BcoinAmount } from "./BcoinAmount";

type Batch = {
  label: string;
  total: number;
  done: number;
  completed: number;
  noSpeech: number;
  skipped: number;
  failed: number;
  stopping: boolean;
  running: boolean;
  message: string;
};

type BatchPlan = {
  owner: string;
  total: number;
  videos: { assetId: string; quote: VideoTranscriptQuote }[];
  exclusions: Map<string, number>;
};

const useBatch = create<{ task: Batch | null }>(() => ({ task: null }));

function updateBatch(update: Partial<Batch>) {
  const task = useBatch.getState().task;
  if (task) useBatch.setState({ task: { ...task, ...update } });
}

async function prepareBatch(ids: string[], owner: string, isCurrent: () => boolean, onProgress: (checked: number) => void) {
  const plan: BatchPlan = { owner, total: ids.length, videos: [], exclusions: new Map() };
  const exclude = (reason: string) => plan.exclusions.set(reason, (plan.exclusions.get(reason) ?? 0) + 1);
  // Each quote reads the original. Keep connected disk and network storage reads sequential.
  for (const [index, assetId] of ids.entries()) {
    if (!isCurrent()) return null;
    try {
      const saved = await getVideoTranscript(assetId);
      if (!isCurrent()) return null;
      if (isPendingOriginal(assetId)) exclude("原件暂不可用。");
      else if (saved?.status === "completed" || saved?.status === "no_speech") exclude("已有转录结果。");
      else if (saved?.status === "no_audio") exclude("视频没有音轨。");
      else if (saved?.status === "running") exclude("视频正在转录。");
      else if (saved?.cloudPending) exclude("请在视频预览中恢复原任务。");
      else {
        const quote = await quoteVideoTranscript(assetId);
        if (!isCurrent()) return null;
        if (quote.cloudPending) exclude("请在视频预览中恢复原任务。");
        else if (quote.noAudio) exclude("视频没有音轨。");
        else if (!quote.chargeRequired) exclude("已有转录结果。");
        else plan.videos.push({ assetId, quote });
      }
    } catch (reason) {
      exclude(userErrorMessage(reason, "无法核对原件和音轨。"));
    }
    if (isCurrent()) onProgress(index + 1);
  }
  return plan;
}

async function runBatch(plan: BatchPlan, label: string, price: number) {
  if (useBatch.getState().task?.running) return;
  let completed = 0;
  let noSpeech = 0;
  let skipped = plan.total - plan.videos.length;
  let failed = 0;
  let message = "";
  useBatch.setState({ task: { label, total: plan.total, done: skipped, completed, noSpeech, skipped, failed, stopping: false, running: true, message } });
  for (const { assetId, quote } of plan.videos) {
    if (useBatch.getState().task?.stopping) break;
    const auth = useStore.getState().cloudAuth;
    if (!auth?.logged_in || auth.user_id !== plan.owner) {
      message = "Cloud 账号已切换，剩余视频未提交。";
      break;
    }
    let submitted = false;
    let uncertain = false;
    let quoteChanged = false;
    try {
      const saved = await getVideoTranscript(assetId);
      if (saved?.cloudPending) {
        failed++;
        uncertain = true;
      } else if ((saved && saved.status !== "interrupted") || isPendingOriginal(assetId)) {
        skipped++;
      } else {
        if (useBatch.getState().task?.stopping) break;
        submitted = true;
        let result: VideoTranscript | null = await startVideoTranscript(assetId, plan.owner, price, quote);
        while (result?.status === "running") {
          await new Promise(resolve => setTimeout(resolve, 1600));
          result = await getVideoTranscript(assetId);
        }
        if (result?.status === "completed") completed++;
        else if (result?.status === "no_speech") { completed++; noSpeech++; }
        else if (result?.status === "no_audio") skipped++;
        else {
          failed++;
          message = userErrorMessage(result?.error, "有视频未完成转录，可在视频预览中查看或恢复原任务。");
          uncertain = !result || result.cloudPending === true;
          quoteChanged = Boolean(result?.quoteRequired || result?.priceChanged);
        }
      }
    } catch (reason) {
      failed++;
      message = userErrorMessage(reason, "有视频未完成转录，可在视频预览中查看或恢复原任务。");
      uncertain = submitted;
    }
    if (uncertain) message = "当前视频的云端任务尚未确认，剩余视频未提交。请在视频预览中恢复原任务。";
    else if (quoteChanged) message = "需要重新核对音轨和费用，剩余视频未提交。";
    updateBatch({ done: completed + skipped + failed, completed, noSpeech, skipped, failed, message });
    if (uncertain || quoteChanged) break;
  }
  updateBatch({ running: false, message });
}

export function VideoTranscriptBatchButton({ scope }: { scope: VideoBatchScope }) {
  const { projectId, label, folderId } = scope;
  const [open, setOpen] = useState(false);
  const task = useBatch(state => state.task);
  const owner = useStore(state => state.cloudAuth?.cloud_available && state.cloudAuth.logged_in ? state.cloudAuth.user_id : null);
  const canStartNew = useVideoTranscriptPrice(owner).credits !== null;
  if (!open && !task && !canStartNew) return null;
  return <>
    <button type="button" className="library-filter-trigger" title="批量转录视频" aria-label="批量转录视频" onClick={() => setOpen(true)}>
      <Captions size={14} aria-hidden="true"/>
    </button>
    {open && <VideoTranscriptBatch key={`${projectId ?? ""}:${folderId ?? ""}`} scope={{ projectId, label, folderId }} task={task} canStartNew={canStartNew} onClose={() => setOpen(false)}/>}
  </>;
}

function VideoTranscriptBatch({ scope, task, canStartNew, onClose }: { scope: VideoBatchScope; task: Batch | null; canStartNew: boolean; onClose: () => void }) {
  const { projectId, folderId, label } = scope;
  const [descendants, setDescendants] = useState(false);
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [progress, setProgress] = useState<{ checked: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const auth = useStore(state => state.cloudAuth);
  const owner = auth?.logged_in ? auth.user_id ?? null : null;
  const currentPlan = owner && plan?.owner === owner ? plan : null;
  const price = useVideoTranscriptPrice(canStartNew && !task && currentPlan?.videos.length ? owner : null);

  useEffect(() => {
    if (task || !owner || !canStartNew) return;
    let current = true;
    setPlan(null);
    setProgress(null);
    setError("");
    void (async () => {
      const ids = await videoBatchScopeIds({ projectId, folderId, label }, descendants, () => current);
      if (!current) return;
      setProgress({ checked: 0, total: ids.length });
      const next = await prepareBatch(ids, owner, () => current, checked => setProgress({ checked, total: ids.length }));
      if (current) setPlan(next);
    })().catch(reason => {
      if (current) setError(userErrorMessage(reason, "无法读取当前范围的视频，请关闭后重试。"));
    });
    return () => { current = false; };
  }, [projectId, folderId, label, descendants, task, owner, canStartNew]);

  const canStart = Boolean(canStartNew && currentPlan?.videos.length && price.credits !== null);
  const start = () => {
    if (!canStart || !currentPlan || price.credits === null) return;
    void runBatch(currentPlan, label, price.credits);
  };

  return <ModalShell title="批量转录视频" onClose={onClose} footer={task
    ? task.running
      ? <button type="button" className="app-button-secondary" disabled={task.stopping} onClick={() => updateBatch({ stopping: true })}>{task.stopping ? "等待当前视频结束" : "停止剩余视频"}</button>
      : canStartNew && <button type="button" className="app-button-secondary" onClick={() => { price.refresh(); useBatch.setState({ task: null }); }}>选择新的范围</button>
    : <button type="button" className="app-button-primary" disabled={!canStart} onClick={start}>开始转录</button>}>
    {task ? <div className="grid gap-3" role="status">
      <p>{task.label} · {task.done} / {task.total}</p>
      <progress className="w-full" max={task.total} value={task.done} aria-label="批量转录进度"/>
      <p>完成 {task.completed}，跳过 {task.skipped}，未完成 {task.failed}{!task.running && task.done < task.total ? `，未提交 ${task.total - task.done}` : ""}</p>
      {task.noSpeech > 0 && <p>已完成的视频中，{task.noSpeech} 个未识别到语音。</p>}
      {task.message && <p>{task.message}</p>}
    </div> : <div className="grid gap-3">
      <p>{label}</p>
      {folderId && <label className="flex items-center gap-2"><input type="checkbox" checked={descendants} onChange={event => { setPlan(null); setProgress(null); setDescendants(event.target.checked); }}/> 包含子文件夹</label>}
      {error && <p role="alert">{error}</p>}
      {!owner ? <p>请先登录 Bowerbird 账号。</p> : !canStartNew ? <p role="status">视频转录服务暂不可用。</p> : !error && (currentPlan
        ? <>
          <p>本次可处理 {currentPlan.videos.length} 个视频，跳过 {currentPlan.total - currentPlan.videos.length} 个。</p>
          {Array.from(currentPlan.exclusions, ([reason, count]) => <p key={reason}>{reason}（{count} 个视频）</p>)}
          {!!currentPlan.videos.length && (price.credits === null ? <>
              <p role="status">{price.loading ? "正在读取转录价格…" : "视频转录服务暂不可用。"}</p>
              {!price.loading && <button type="button" className="app-button-secondary" onClick={price.refresh}>刷新服务状态</button>}
            </> : <>
              <p>单条 <BcoinAmount amount={price.credits}/>，本次 {currentPlan.videos.length} 条音轨，合计 <BcoinAmount amount={price.credits * currentPlan.videos.length}/>。</p>
            </>)}
        </>
        : <p role="status">{progress ? `正在核对音轨和费用（${progress.checked} / ${progress.total}）…` : "正在统计视频…"}</p>)}
    </div>}
  </ModalShell>;
}
