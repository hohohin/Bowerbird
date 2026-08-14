import { useEffect, useMemo, useState } from "react";
import { Check, RotateCw, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import { understandProvider } from "../lib/entitlement";
import { notifyError, notifySuccess } from "../lib/notify";
import type { Analysis, Asset, LocalAgentRun } from "../lib/types";
import { useStore } from "../store";

const INSPECTION_PROMPT =
  "请复检这张智能精修后的图片：对照目标说明构图、光影、色调、氛围与材质是否改善，指出仍存在的问题。只描述图中可见证据，不猜测。";

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

function analysisText(analysis: Analysis | undefined): string {
  if (!analysis) return "复检已完成";
  try {
    const value = JSON.parse(analysis.payload);
    return typeof value?.text === "string" ? value.text : analysis.payload;
  } catch {
    return analysis.payload;
  }
}

function phaseLabel(run: LocalAgentRun | null): string {
  if (!run) return "尚未启动";
  if (run.status === "awaiting_approval") return "等待你确认计划";
  if (run.status === "awaiting_tool") {
    return run.checkpoint.pendingTool?.action === "refine_once" ? "等待执行精修" : "等待复检结果";
  }
  if (run.status === "succeeded") return "本轮完成";
  if (run.status === "cancelled") return "已取消";
  if (run.status === "failed") return "运行失败";
  return "分析中";
}

export function LocalAgentPanel({
  asset,
  hasCaption,
  onAnalyze,
}: {
  asset: Asset;
  hasCaption: boolean;
  onAnalyze: () => void;
}) {
  const assets = useStore((state) => state.assets);
  const activeProvider = useStore((state) => state.activeGenProvider);
  const startGeneration = useStore((state) => state.startGeneration);
  const cloudEntitlement = useStore((state) => state.cloudEntitlement);
  const [available, setAvailable] = useState(false);
  const [run, setRun] = useState<LocalAgentRun | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.localAgentHealth(), api.localAgentLatest(asset.id)])
      .then(([health, latest]) => {
        if (cancelled) return;
        setAvailable(health);
        setRun(latest);
        if (latest?.checkpoint.input.goal) setGoal(latest.checkpoint.input.goal);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => { cancelled = true; };
  }, [asset.id]);

  const score = useMemo(() => {
    const record = run?.checkpoint.records.find((item) => item.action === "score_dimensions");
    const scores = record?.arguments?.scores;
    return Array.isArray(scores) ? scores : [];
  }, [run]);
  const plan = run?.checkpoint.approval?.arguments?.changes;

  async function start() {
    if (!goal.trim()) return;
    setBusy(true);
    setStage("DeepSeek 正在评估并形成一次精修计划…");
    setError(null);
    try {
      setRun(await api.localAgentStart(asset.id, goal.trim()));
    } catch (cause) {
      setError(errorText(cause));
      notifyError(cause, "启动智能精修失败");
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function reject() {
    if (!run) return;
    setBusy(true);
    try {
      setRun(await api.localAgentResume(run.id, { approval: false }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function executePending(current: LocalAgentRun): Promise<LocalAgentRun> {
    const pending = current.checkpoint.pendingTool;
    if (!pending) return current;
    if (pending.action === "refine_once") {
      const prompt = pending.arguments.prompt?.trim();
      if (!prompt) throw new Error("Agent 没有给出可执行的精修提示词");
      const ids = pending.arguments.referenceAssetIds ?? [asset.id];
      const references = ids
        .map((id) => id === asset.id ? asset : assets.find((item) => item.id === id))
        .filter((item): item is Asset => !!item);
      setStage(`正在通过 ${activeProvider} 执行一次精修…`);
      const jobId = await startGeneration(prompt, references, pending.arguments.ratio ?? null, activeProvider);
      const state = useStore.getState();
      const job = state.genJobs[jobId];
      const lastTurn = job?.turns[job.turns.length - 1];
      const generatedPath = lastTurn?.images[lastTurn.images.length - 1];
      if (!generatedPath) throw new Error(lastTurn?.error || "精修 provider 未返回图片");
      return api.localAgentResume(current.id, {
        toolResult: {
          callId: pending.callId,
          result: { generatedImagePath: generatedPath, provider: activeProvider },
        },
      });
    }

    const generatedRecord = [...current.checkpoint.records]
      .reverse()
      .find((record) => record.action === "refine_once");
    const result = generatedRecord?.result as { generatedImagePath?: string } | undefined;
    if (!result?.generatedImagePath) throw new Error("找不到精修产物路径，无法复检");
    const generatedAssetId = await api.localAgentFindAssetId(result.generatedImagePath);
    if (!generatedAssetId) throw new Error("精修图片已经生成，但尚未在素材库中找到");
    const provider = understandProvider(cloudEntitlement);
    if (!provider) throw new Error("当前账号没有可用的图片理解 provider");
    setStage("正在复检精修结果…");
    const analysisId = await api.describeAsset(generatedAssetId, INSPECTION_PROMPT, provider);
    const analyses = await api.listAnalysesByAsset(generatedAssetId);
    return api.localAgentResume(current.id, {
      toolResult: {
        callId: pending.callId,
        result: {
          generatedAssetId,
          summary: analysisText(analyses.find((item) => item.id === analysisId)),
        },
      },
    });
  }

  async function continueRun(approve = false) {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      let next = approve
        ? await api.localAgentResume(run.id, { approval: true })
        : run;
      setRun(next);
      while (next.status === "awaiting_tool") {
        next = await executePending(next);
        setRun(next);
      }
      if (next.status === "succeeded") notifySuccess("智能精修已完成并入库");
    } catch (cause) {
      setError(errorText(cause));
      notifyError(cause, "智能精修未完成，可稍后继续");
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  if (!available) return null;

  return (
    <div className="asset-detail-card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-accent">
            <Sparkles size={13} /> 智能精修
          </div>
          <div className="mt-1 text-[10px] text-muted">本机预览 · DeepSeek 规划 · 最多生成一次</div>
        </div>
        <span className="rounded-full border border-edge px-2 py-0.5 text-[10px] text-muted">
          {phaseLabel(run)}
        </span>
      </div>

      {!hasCaption ? (
        <div className="rounded-lg border border-edge bg-panel2 p-2 text-xs text-muted">
          Agent 需要先看懂目标图。请先完成一次反推，结果会作为不可信素材摘要送入规划回合。
          <button type="button" onClick={onAnalyze} className="mt-2 block text-accent hover:underline">
            先反推这张图
          </button>
        </div>
      ) : (
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          disabled={busy || run?.status === "awaiting_approval" || run?.status === "awaiting_tool"}
          className="h-20 w-full resize-none rounded-lg bg-panel2 p-2 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent disabled:opacity-60"
          placeholder="例如：保留构图，把主体提亮，统一成清爽的冷白色调。"
          maxLength={4000}
        />
      )}

      {score.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {score.slice(0, 8).map((item, index) => {
            const value = item as { dim?: string; dimension?: string; score?: number };
            const label = value.dimension ?? value.dim ?? "维度";
            return <span key={`${label}-${index}`} className="rounded bg-panel2 px-1.5 py-1 text-[10px] text-muted">{label} {value.score ?? "-"}</span>;
          })}
        </div>
      )}

      {plan && (
        <div className="rounded-lg border border-accent/35 bg-accent/5 p-2 text-xs leading-5 text-ink">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-accent">一次精修计划</div>
          {plan}
        </div>
      )}

      {stage && <div className="text-xs text-muted">{stage}</div>}
      {error && <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-2 text-xs text-red-300">{error}</div>}

      <div className="flex justify-end gap-2">
        {run?.status === "awaiting_approval" ? (
          <>
            <button type="button" onClick={reject} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-edge px-2.5 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"><X size={12} />取消</button>
            <button type="button" onClick={() => void continueRun(true)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"><Check size={12} />确认并精修一次</button>
          </>
        ) : run?.status === "awaiting_tool" ? (
          <button type="button" onClick={() => void continueRun()} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"><RotateCw size={12} />继续本轮</button>
        ) : (
          <button type="button" onClick={() => void start()} disabled={busy || !hasCaption || !goal.trim()} className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"><Sparkles size={12} />{run ? "新建精修计划" : "开始评估"}</button>
        )}
      </div>
    </div>
  );
}
