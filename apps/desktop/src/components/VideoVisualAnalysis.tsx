import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVideoAnalysisCapabilities, getVideoAnalysisProgress, hasVideoAnalysisPrice, pauseVideoAnalysis, quoteVideoAnalysis, startVideoAnalysis, formatVideoAnalysisDuration, type PricedVideoAnalysisQuote, type VideoAnalysisProgress, type VideoAnalysisQuote } from "../lib/videoAnalysis";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import { BcoinAmount } from "./BcoinAmount";
import { ModalShell } from "./ModalShell";

type Status = {
  quote?: VideoAnalysisQuote;
  progress?: VideoAnalysisProgress | null;
  error?: string;
  available?: boolean;
};

export function useVideoVisualAnalysis(assetId: string | undefined, sourceKey: string) {
  const owner = useStore(state => state.cloudAuth?.logged_in && state.cloudAuth.cloud_available ? state.cloudAuth.user_id : null);
  const key = JSON.stringify([assetId, sourceKey, owner]);
  const [record, setRecord] = useState<{ key: string; status: Status }>();
  const [revision, setRevision] = useState(0);
  const status = record?.key === key ? record.status : {};
  const refresh = () => {
    setRecord(current => current?.key === key ? { key, status: { ...current.status, quote: undefined } } : current);
    setRevision(current => current + 1);
  };

  useEffect(() => {
    if (!assetId || !owner) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    function update(patch: Status) {
      if (!stopped) setRecord(current => ({ key, status: { ...(current?.key === key ? current.status : {}), ...patch } }));
    }
    async function readProgress() {
      try {
        const progress = await getVideoAnalysisProgress(assetId!);
        update({ progress });
        if (!stopped && progress?.status === "running") timer = setTimeout(readProgress, 1500);
        if (!stopped && progress?.status === "completed") update({ quote: undefined });
        if (!stopped && progress?.status === "interrupted" && (progress.cloudPending || progress.quoteRequired)) {
          update({ quote: undefined });
          update({ quote: await quoteVideoAnalysis(assetId!) });
        }
      } catch (reason) {
        update({ error: userErrorMessage(reason, "无法读取画面分析进度。") });
      }
    }
    void (async () => {
      try {
        const [capabilities, progress] = await Promise.all([getVideoAnalysisCapabilities(), getVideoAnalysisProgress(assetId)]);
        if (stopped) return;
        update({ available: capabilities.available, error: undefined, progress });
        if (progress?.status === "running") timer = setTimeout(readProgress, 1500);
        else if ((capabilities.available || progress?.cloudPending) && progress?.status !== "completed") {
          update({ quote: await quoteVideoAnalysis(assetId) });
        } else {
          update({ quote: undefined });
        }
      } catch (reason) {
        update({ error: userErrorMessage(reason, "无法读取画面分析报价。") });
      }
    })();
    return () => { stopped = true; clearTimeout(timer); };
  }, [assetId, key, owner, revision]);

  return { ...status, owner, refresh };
}

function useSavedVideoDescription(assetId: string, progress: VideoAnalysisProgress["status"] | undefined) {
  const [description, setDescription] = useState<{ text: string } | null>(null);
  useEffect(() => {
    let current = true;
    void invoke<{ text: string } | null>("video_analysis_get", { assetId }).then(result => {
      if (current) setDescription(result);
    }).catch(() => { if (current) setDescription(null); });
    return () => { current = false; };
  }, [assetId, progress]);
  return description?.text;
}

export function VideoVisualAnalysis({ assetId, state }: { assetId: string; state: ReturnType<typeof useVideoVisualAnalysis> }) {
  const { owner, quote, progress, available, error, refresh } = state;
  const [confirming, setConfirming] = useState<PricedVideoAnalysisQuote>();
  const [submitting, setSubmitting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [startError, setStartError] = useState("");
  const description = useSavedVideoDescription(assetId, progress?.status);
  const running = submitting || progress?.status === "running";
  const pending = progress?.cloudPending || quote?.cloudPending;
  const actionError = startError || (progress?.status === "interrupted" && progress.error
    ? userErrorMessage(progress.error, "画面分析尚未完成。") : "");
  if (description) return <section className="flex flex-col gap-2" aria-label="画面描述">
    <h3 className="font-medium">画面描述</h3>
    <p className="whitespace-pre-wrap break-words">{description}</p>
  </section>;
  if (!running && (progress?.status === "completed" || (quote && !quote.chargeRequired && !pending))) return null;

  async function start(authorization: PricedVideoAnalysisQuote) {
    if (running || !owner) return;
    setConfirming(undefined);
    setStartError("");
    setPausing(false);
    setSubmitting(true);
    try {
      const result = await startVideoAnalysis(assetId, owner, authorization);
      if (result.status === "interrupted") setStartError(userErrorMessage(result.error, "画面分析暂停，可恢复原任务。"));
    } catch (reason) {
      setStartError(userErrorMessage(reason, "画面分析未完成，请查看任务状态。"));
    } finally {
      setSubmitting(false);
      refresh();
    }
  }

  async function pause() {
    if (!owner || pausing) return;
    setPausing(true);
    try {
      if (!await pauseVideoAnalysis(assetId, owner)) setPausing(false);
    } catch (reason) {
      setPausing(false);
      setStartError(userErrorMessage(reason, "无法暂停后续分段。"));
    } finally {
      refresh();
    }
  }

  return <section aria-label="画面描述操作" className="mb-4 space-y-2 border-b border-edge pb-4">
    <h3 className="font-medium">画面描述</h3>
    {running ? <>
      <p role="status">{progress?.segmentCount ? `已完成 ${progress.completedSegments} / ${progress.segmentCount} 段` : "正在准备画面分析…"}</p>
      {Boolean(progress?.segmentCount) && <progress aria-label="画面分析分段进度" className="w-full" max={progress?.segmentCount} value={progress?.completedSegments}/>}
      {progress && progress.segmentCount - progress.completedSegments > 1 && <button type="button" className="app-button-secondary"
        disabled={pausing} onClick={() => void pause()}>{pausing ? "完成当前段后暂停" : "暂停后续分段"}</button>}
    </> : hasVideoAnalysisPrice(quote) && (quote.chargeRequired || pending) ? <>
      <p className="text-xs text-muted">原片 {formatVideoAnalysisDuration(quote.durationSeconds)} · {quote.segmentCount} 段</p>
      <button type="button" className="app-button-primary" onClick={() => pending ? void start(quote) : setConfirming(quote)}>
        {pending ? "恢复原画面分析任务" : <>开始画面分析 · <BcoinAmount amount={quote.credits}/></>}
      </button>
    </> : (!quote || quote.chargeRequired) && <p role="status">{error || (!owner ? "请先登录 Bowerbird 账号。" : available === false ? "画面分析服务暂未开放。" : quote ? "画面分析报价暂不可用。" : "正在读取画面分析报价…")}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {error && <button type="button" className="app-button-secondary" onClick={refresh}>刷新状态</button>}
    {confirming && <ModalShell title="确认画面分析" width="sm" onClose={() => setConfirming(undefined)}
      footer={<>
        <button type="button" className="app-modal-button" onClick={() => setConfirming(undefined)}>取消</button>
        <button type="button" className="app-modal-button is-primary" onClick={() => void start(confirming)}>确认</button>
      </>}>
      <p>原片总时长 {formatVideoAnalysisDuration(confirming.durationSeconds)} · 共 {confirming.segmentCount} 段 · <BcoinAmount amount={confirming.credits}/></p>
    </ModalShell>}
  </section>;
}
