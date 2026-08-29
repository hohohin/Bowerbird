import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Circle, RefreshCw, Sparkles, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { cloudAgentFailureMessage, cloudAgentStatusLabel } from "../lib/cloudAgent";
import { notifyError, notifySuccess } from "../lib/notify";
import type { CloudAgentApproval, CloudAgentArtifact, CloudAgentPlan, CloudAgentPlanStep, CloudAgentPreview } from "../lib/types";
import { useStore } from "../store";
import { Lightbox } from "./Lightbox";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const CURRENT_CONTROLLED_SKILL_VERSION = "0.1.2";
const CURRENT_HTML_SKILL_VERSION = "0.1.0";
const HTML_SKILL_ID = "bowerbird-html-layout-render";

function strategyLabel(strategy?: string): string {
  if (strategy === "direct") return "直接单步";
  if (strategy === "controlled") return "一致性控制";
  if (strategy === "staged_controlled") return "分阶段控制";
  return "动态计划";
}

function PendingPlan({ approval }: { approval: CloudAgentApproval }) {
  const plan = approval.proposal as CloudAgentPlan | undefined;
  if (!plan) return <p className="text-xs text-muted">计划正文正在同步，请稍候。</p>;
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-black/20 p-3 ring-1 ring-white/8">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold text-ink">Agent 对真实意图的理解</span>
          <span className="rounded bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
            {strategyLabel(plan.strategy)}
          </span>
        </div>
        <p className="text-xs leading-5 text-ink/85">{plan.intentSummary}</p>
      </div>

      {plan.referenceRoles.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted">参考图职责</div>
          <div className="flex flex-wrap gap-1.5">
            {plan.referenceRoles.map((reference) => (
              <span key={reference.referenceId} className="rounded bg-white/6 px-2 py-1 text-[10px] text-ink/80">
                {reference.referenceId} · {reference.role}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {plan.steps.map((step, index) => (
          <div key={step.id} className="rounded-lg border border-edge bg-panel2/70 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-ink">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-[10px] text-accent">
                {index + 1}
              </span>
              <span>{step.goal}</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-muted">{step.rationale}</p>
            {(step.preserves.length > 0 || step.modifies.length > 0 || step.excludes.length > 0) && (
              <div className="mt-2 text-[10px] leading-4 text-muted">
                {step.modifies.length > 0 && <div>修改：{step.modifies.join("、")}</div>}
                {step.preserves.length > 0 && <div>保持：{step.preserves.join("、")}</div>}
                {step.excludes.length > 0 && <div>排除：{step.excludes.join("、")}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
        <span>计划工具调用：{approval.planned_tool_count ?? plan.steps.length}</span>
        <span>本次最多新增：{approval.estimated_additional_credits ?? 0} 积分</span>
      </div>
    </div>
  );
}

function artifactRoleLabel(role?: string): string {
  if (role === "control_reference") return "控制参考图";
  if (role === "stage_result") return "阶段结果图";
  if (role === "final_result") return "最终结果图";
  if (role === "viewport_screenshot") return "视口截图";
  if (role === "full_page_screenshot") return "整页截图";
  if (role === "slice_screenshot") return "切片截图";
  return "过程产物";
}

function eventTitle(type: string): string {
  const labels: Record<string, string> = {
    "intent.analysis.completed": "已完成意图判断",
    "plan.proposed": "已形成执行计划",
    "plan.revision.proposed": "已形成修订计划",
    "step.started": "正在执行步骤",
    "step.completed": "已完成步骤",
    "result.ready": "结果已准备好",
    "feedback.diagnosis.started": "收到修改意见，正在定向诊断",
    "feedback.diagnosis.completed": "已完成反馈诊断",
    "result.accepted": "已接受结果",
    "run.succeeded": "Agent 会话已完成",
    "html.compose.started": "正在编写受限 HTML/CSS",
    "html.composed": "HTML/CSS 已完成并通过校验",
    "html.render.completed": "离线渲染已完成",
  };
  return labels[type] ?? type;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function TimelineEvent({
  event,
  step,
  artifact,
  preview,
  onPreview,
}: {
  event: { seq: number; type: string; step?: string | null; progress?: number | null; display_payload?: Record<string, unknown> };
  step?: CloudAgentPlanStep;
  artifact?: CloudAgentArtifact;
  preview?: CloudAgentPreview;
  onPreview: (path: string) => void;
}) {
  const payload = event.display_payload ?? {};
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  const goal = typeof payload.goal === "string" ? payload.goal : step?.goal;
  const rationale = typeof payload.rationale === "string" ? payload.rationale : step?.rationale;
  const preserves = textList(payload.preserves);
  const excludes = textList(payload.excludes);
  const ratio = typeof payload.ratio === "string" ? payload.ratio : undefined;
  const completed = event.type === "step.completed" || event.type === "result.ready" || event.type === "run.succeeded";
  return (
    <div className="relative pl-7">
      <span className="absolute left-0 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-edge bg-panel2 text-lime">
        {completed ? <Check size={11} /> : event.type === "step.started" ? <RefreshCw size={10} className="animate-spin" /> : <Circle size={9} />}
      </span>
      <div className="absolute bottom-[-14px] left-[9px] top-5 w-px bg-edge" />
      <div className="rounded-lg border border-edge bg-panel2/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-ink">{eventTitle(event.type)}</span>
          {event.progress != null && <span className="text-[10px] text-muted">{event.progress}%</span>}
        </div>
        {(summary || goal) && <p className="mt-1.5 text-[11px] leading-5 text-ink/85">{summary ?? goal}</p>}
        {rationale && <p className="mt-1 text-[10px] leading-4 text-muted">判断依据：{rationale}</p>}
        {(ratio || preserves.length > 0 || excludes.length > 0) && (
          <div className="mt-2 space-y-0.5 text-[10px] leading-4 text-muted">
            {ratio && <div>最终比例：{ratio}</div>}
            {preserves.length > 0 && <div>保持：{preserves.join("、")}</div>}
            {excludes.length > 0 && <div>排除：{excludes.join("、")}</div>}
          </div>
        )}
        {artifact && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] text-muted">{artifactRoleLabel(artifact.role)}</div>
            {preview ? (
              <button type="button" onClick={() => onPreview(preview.path)} className="block w-fit cursor-zoom-in">
                <img src={convertFileSrc(preview.path)} alt={artifactRoleLabel(artifact.role)} className="block max-h-72 w-auto max-w-full rounded border border-edge" />
              </button>
            ) : (
              <div className="rounded border border-edge bg-black/15 px-3 py-2 text-[10px] text-muted">正在校验并载入过程图…</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Agent Run 会话内容。它与普通生成共用 genPanelOpen / 侧栏会话入口和主区详情外壳，
 * 仅数据源保持独立：Agent 权威状态来自 cloud_agent_runs，不塞进 generation task_queue。
 */
export function CloudAgentSession() {
  const activeRunId = useStore((state) => state.activeCloudAgentRunId);
  const run = useStore((state) => activeRunId ? state.cloudAgentRuns[activeRunId] ?? null : null);
  const assets = useStore((state) => state.assets);
  const genPanelOpen = useStore((state) => state.genPanelOpen);
  const activeSessionKind = useStore((state) => state.activeSessionKind);
  const setGenPanelOpen = useStore((state) => state.setGenPanelOpen);
  const updateRun = useStore((state) => state.updateCloudAgentRun);
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, CloudAgentPreview>>({});
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ingestRetry, setIngestRetry] = useState(0);
  const [ingestComplete, setIngestComplete] = useState(false);
  const [ingestFailed, setIngestFailed] = useState(false);
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const previewLoading = useRef(new Set<string>());
  const ingesting = useRef<string | null>(null);
  const reconciledIngest = useRef(new Set<string>());
  const reconciledTerminal = useRef(new Set<string>());

  useEffect(() => {
    if (run?.runId) reconciledIngest.current.delete(run.runId);
    setArtifactPreviews({});
    setFeedback("");
    setError(null);
    setIngestRetry(0);
    setIngestComplete(false);
    setIngestFailed(false);
    setLightbox(null);
    localTaskBusy.current = null;
  }, [run?.runId]);

  // 本地 CLI Run 停车等待生图：发现 pendingLocalTask 即驱动本机执行。命令内部完成
  // 「解析输入 → 调用任务指定 provider → 直传 → 回报 → 重取」；
  // 失败时云端已原子结算为 failed。网络类瞬断允许下一轮轮询自然重试。
  const pendingLocalTask = run?.snapshot.pendingLocalTask ?? null;
  const localTaskProviderLabel = pendingLocalTask?.provider === "codex" ? "Codex" : "即梦";
  const localTaskBusy = useRef<string | null>(null);
  const [localTaskRunning, setLocalTaskRunning] = useState(false);
  useEffect(() => {
    if (!genPanelOpen || activeSessionKind !== "agent" || !run || !pendingLocalTask) return;
    if (localTaskBusy.current) return;
    localTaskBusy.current = pendingLocalTask.callId;
    setLocalTaskRunning(true);
    api.cloudAgentExecuteLocalTask(run.runId)
      .then((next) => {
        updateRun(next);
        setError(null);
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        localTaskBusy.current = null;
        setLocalTaskRunning(false);
      });
  }, [genPanelOpen, activeSessionKind, run, pendingLocalTask, updateRun]);

  useEffect(() => {
    if (!genPanelOpen || activeSessionKind !== "agent" || !run || TERMINAL.has(run.status)) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await api.cloudAgentGet(run.runId);
        if (alive) {
          updateRun(next);
          setError(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const timer = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [genPanelOpen, activeSessionKind, run?.runId, run?.status, updateRun]);

  const htmlRun = run?.skillId === HTML_SKILL_ID;
  const generatedArtifacts = useMemo(
    () => {
      if (!run) return [];
      const visible = new Map(run.snapshot.artifacts
        .filter((artifact) => artifact.user_visible && artifact.mime.startsWith("image/"))
        .map((artifact) => [artifact.id, artifact]));
      if (run.skillId === HTML_SKILL_ID) {
        return (run.snapshot.renderManifest?.outputs ?? [])
          .map((output) => visible.get(output.artifactId))
          .filter((artifact): artifact is CloudAgentArtifact => !!artifact);
      }
      return [...visible.values()].filter((artifact) => ["control_reference", "stage_result", "final_result"].includes(artifact.role));
    },
    [run],
  );
  const primaryArtifact = useMemo(
    () => generatedArtifacts.find((artifact) => artifact.role === "final_result" || artifact.role === "full_page_screenshot")
      ?? generatedArtifacts.find((artifact) => artifact.role === "viewport_screenshot")
      ?? generatedArtifacts[0]
      ?? null,
    [generatedArtifacts],
  );
  const pendingApproval = useMemo(
    () => run?.snapshot.approvals.find((approval) => approval.status === "pending") ?? null,
    [run?.snapshot.approvals],
  );
  const pendingClarification = useMemo(
    () => run?.snapshot.clarifications?.find((item) => item.status === "pending" && item.question) ?? null,
    [run?.snapshot.clarifications],
  );
  const referenceAssets = useMemo(
    () => run?.referenceAssetIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean) ?? [],
    [run?.referenceAssetIds, assets],
  );
  const currentSkillVersion = htmlRun ? CURRENT_HTML_SKILL_VERSION : CURRENT_CONTROLLED_SKILL_VERSION;
  const skillVersionMismatch = !!run && run.snapshot.run.skill_version !== currentSkillVersion;
  const approvalsWithPlans = useMemo(
    () => [...(run?.snapshot.approvals ?? [])].filter((approval) => !!approval.proposal).sort((a, b) => a.requested_at.localeCompare(b.requested_at)),
    [run?.snapshot.approvals],
  );
  const planSteps = useMemo(() => approvalsWithPlans.flatMap((approval) => approval.proposal?.steps ?? []), [approvalsWithPlans]);
  const timelineEvents = useMemo(() => {
    if (!run) return [];
    if (run.snapshot.events.length) return [...run.snapshot.events].sort((a, b) => a.seq - b.seq);
    return planSteps.map((step, index) => {
      const artifact = generatedArtifacts.find((item) => item.step_id === step.id);
      return {
        seq: index + 1,
        type: artifact ? "step.completed" : "step.started",
        step: step.id,
        progress: artifact ? 80 : run.snapshot.run.progress,
        display_payload: { goal: step.goal, rationale: step.rationale, artifactId: artifact?.id },
        created_at: "",
      };
    });
  }, [run, planSteps, generatedArtifacts]);

  useEffect(() => {
    if (!genPanelOpen || activeSessionKind !== "agent" || !run) return;
    for (const artifact of generatedArtifacts) {
      if (artifactPreviews[artifact.id] || previewLoading.current.has(artifact.id)) continue;
      previewLoading.current.add(artifact.id);
      api.cloudAgentPreviewArtifact(run.runId, artifact.id)
        .then((value) => {
          setArtifactPreviews((current) => ({ ...current, [artifact.id]: value }));
          setError(null);
        })
        .catch((cause) => {
          if (artifact.id === primaryArtifact?.id) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => previewLoading.current.delete(artifact.id));
    }
  }, [genPanelOpen, activeSessionKind, run, generatedArtifacts, artifactPreviews, primaryArtifact]);

  useEffect(() => {
    if (!genPanelOpen || activeSessionKind !== "agent" || !run || !TERMINAL.has(run.status) || reconciledTerminal.current.has(run.runId)) return;
    reconciledTerminal.current.add(run.runId);
    api.cloudAgentGet(run.runId).then(updateRun).catch(() => reconciledTerminal.current.delete(run.runId));
  }, [genPanelOpen, activeSessionKind, run, updateRun]);

  useEffect(() => {
    if (!run || run.status !== "succeeded" || run.feedbackAction !== "accept" || !primaryArtifact) return;
    if (ingesting.current === primaryArtifact.id || reconciledIngest.current.has(run.runId)) return;
    reconciledIngest.current.add(run.runId);
    ingesting.current = primaryArtifact.id;
    api.cloudAgentIngestArtifacts(run.runId)
      .then(async (assets) => {
        notifySuccess(`Agent 的 ${assets.length} 张产物已作为同一组加入素材库`);
        setIngestComplete(true);
        setIngestFailed(false);
        updateRun(await api.cloudAgentGet(run.runId));
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setIngestFailed(true);
        notifyError(cause, "Agent 产物整组入库失败");
      })
      .finally(() => {
        ingesting.current = null;
      });
  }, [run, primaryArtifact, updateRun, ingestRetry]);

  async function decide(approve: boolean) {
    if (!run || !pendingApproval || busy) return;
    setBusy(true);
    setError(null);
    try {
      updateRun(await api.cloudAgentDecideApproval(run.runId, pendingApproval.id, approve));
      if (!approve) notifySuccess("已拒绝计划并安全结算");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      notifyError(cause, approve ? "批准计划失败" : "拒绝计划失败");
    } finally {
      setBusy(false);
    }
  }

  async function answerClarification(answer: string) {
    if (!run || !pendingClarification || busy) return;
    setBusy(true);
    setError(null);
    try {
      updateRun(await api.cloudAgentAnswerClarification(
        run.runId,
        pendingClarification.id,
        pendingClarification.context_hash,
        answer,
      ));
      notifySuccess("答案已提交，Agent 将按新意图重新规划");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      notifyError(cause, "提交 Agent 澄清答案失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitFeedback(action: "accept" | "retry") {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      updateRun(await api.cloudAgentFeedback(run.runId, action, feedback));
      if (action === "retry") {
        setArtifactPreviews({});
        notifySuccess("反馈已提交，Agent 将诊断后给出新的修订计划");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      notifyError(cause, "提交 Agent 反馈失败");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run || busy) return;
    setBusy(true);
    setError(null);
    try {
      updateRun(await api.cloudAgentCancel(run.runId));
      notifySuccess("Agent Run 已请求安全取消");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      notifyError(cause, "取消 Agent Run 失败");
    } finally {
      setBusy(false);
    }
  }

  if (!run) return null;
  const progress = Math.max(0, Math.min(100, Number(run.snapshot.run.progress ?? 0)));
  const canCancel = !TERMINAL.has(run.status) && run.status !== "cancel_requested";
  const title = run.intentPrompt.split("\n").find((line) => line.trim())?.trim() || "Bowerbird Agent";

  return (
    <>
      <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
      <div className="gen-view-in flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-[38px] shrink-0 items-center gap-2 border-b border-edge bg-canvas/90 px-3 py-1">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-lime/10 text-lime">
            <Sparkles size={14} />
          </span>
          <strong className="min-w-0 max-w-[420px] truncate text-xs font-semibold" title={run.intentPrompt}>
            {title}
          </strong>
          <span className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted">
            {htmlRun ? "HTML 排版" : "Agent"} · {cloudAgentStatusLabel(run.status)} · {run.referenceAssetIds.length} 张参考图
          </span>
          {!TERMINAL.has(run.status) && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-lime">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime" />
              运行中
            </span>
          )}
          <button
            onClick={() => setGenPanelOpen(false)}
            className="app-icon-button ml-auto"
            title="收起（回到瀑布流，Agent 照常后台运行）"
            aria-label="收起 Agent 会话"
          >
            <X size={16} />
          </button>
        </div>
        <div className="hatch-divider" aria-hidden="true"><span /></div>
        <div className="h-1 shrink-0 bg-black/30">
          <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <div className="flex flex-col items-end gap-1.5">
              {referenceAssets.length > 0 && (
                <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
                  {referenceAssets.map((asset, index) => {
                    if (!asset) return null;
                    const src = asset.thumb_path ?? asset.store_path;
                    return src ? (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => {
                          const images = referenceAssets
                            .map((item) => item?.store_path ?? item?.thumb_path ?? "")
                            .filter(Boolean);
                          setLightbox({ images, index: Math.min(index, images.length - 1) });
                        }}
                        className="cursor-zoom-in"
                        aria-label={`放大参考图 ${index + 1}`}
                      >
                        <img src={convertFileSrc(src)} alt={asset.name} className="h-12 w-12 rounded border border-edge object-cover hover:border-accent/60" />
                      </button>
                    ) : null;
                  })}
                </div>
              )}
              <div className="max-w-[85%] rounded-lg rounded-br-sm border border-edge bg-panel2 px-3 py-2 text-xs leading-relaxed text-ink">
                <span className="whitespace-pre-wrap">{run.intentPrompt}</span>
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-lime/10 text-lime">
                <Sparkles size={13} />
              </span>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="rounded-lg border border-edge bg-panel p-3">
                  <div className="flex items-center gap-2 text-xs text-ink">
                    {!TERMINAL.has(run.status) && <RefreshCw size={13} className="animate-spin text-accent" />}
                    {cloudAgentStatusLabel(run.status)}
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-muted">
                    {run.status === "failed"
                      ? "Agent 已安全停止，未调用后续生图工具。"
                      : run.status === "awaiting_local_task"
                        ? localTaskRunning
                          ? `正在使用本机 ${localTaskProviderLabel} 生成这一步的图片，完成后会自动继续执行计划。`
                          : `等待本机 ${localTaskProviderLabel} 执行生图步骤，即将自动开始。`
                        : run.snapshot.run.current_step === "diagnose_feedback"
                          ? "正在根据你的修改意见定向诊断上一结果，可能需要一分钟左右。"
                          : run.snapshot.run.current_step === "compose_revision_plan"
                            ? "诊断完成，正在制定修订计划；新计划会再次提交给你批准。"
                            : run.snapshot.run.current_step
                              ? `当前步骤：${run.snapshot.run.current_step}`
                              : "Agent 会在需要你决定时暂停。"}
                  </p>
                </div>

                {pendingClarification?.question && (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/8 p-4">
                    <div className="mb-1 text-xs font-semibold text-amber-100">Agent 需要你确认一个关键点</div>
                    <p className="text-xs leading-5 text-ink">{pendingClarification.question.question}</p>
                    <p className="mt-1 text-[10px] leading-4 text-muted">{pendingClarification.question.rationale}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {pendingClarification.question.options.map((option) => {
                        const recommended = option === pendingClarification.question?.recommendedAnswer;
                        return (
                          <button
                            key={option}
                            type="button"
                            disabled={busy}
                            onClick={() => void answerClarification(option)}
                            className={recommended
                              ? "rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                              : "rounded-md border border-edge bg-panel px-3 py-2 text-xs text-ink disabled:opacity-50"}
                          >
                            {option}{recommended ? "（推荐）" : ""}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[10px] text-muted">一次只回答这一项；答案会编译为结构化意图，旧计划不会继续执行。</p>
                  </div>
                )}

                {approvalsWithPlans.map((approval, index) => {
                  const isPending = approval.status === "pending";
                  return (
                    <div key={approval.id} className="rounded-lg border border-edge bg-panel p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 className="text-xs font-semibold text-ink">
                          {approval.kind === "controlled_image_edit_revision" ? `修订计划 ${index + 1}` : "执行计划"}
                        </h3>
                        <span className={`text-[10px] ${isPending ? "text-amber-300" : approval.status === "approved" ? "text-lime" : "text-muted"}`}>
                          {isPending ? "等待批准" : approval.status === "approved" ? "已批准" : approval.status === "rejected" ? "已拒绝" : "已过期"}
                        </span>
                      </div>
                      <PendingPlan approval={approval} />
                      {isPending && skillVersionMismatch && (
                        <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/8 p-3 text-[11px] leading-5 text-amber-200">
                          这份计划由旧版 Skill {run.snapshot.run.skill_version} 创建，当前版本为 {currentSkillVersion}。为避免用不同规则执行旧计划，请拒绝并重新发起。
                        </div>
                      )}
                      {isPending && (
                        <div className="mt-4 flex gap-2">
                          <button disabled={busy || skillVersionMismatch} onClick={() => void decide(true)} className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
                            批准并执行
                          </button>
                          <button disabled={busy} onClick={() => void decide(false)} className="rounded-md border border-edge px-4 py-2 text-xs text-muted hover:text-ink disabled:opacity-50">
                            拒绝并结束
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {timelineEvents.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-[11px] font-semibold text-muted">Agent 执行时间线</div>
                    {timelineEvents.map((event) => {
                      const step = event.step ? planSteps.find((item) => item.id === event.step) : undefined;
                      const payloadArtifactId = typeof event.display_payload?.artifactId === "string" ? event.display_payload.artifactId : undefined;
                      const artifact = event.type === "step.completed"
                        ? generatedArtifacts.find((item) => item.id === payloadArtifactId)
                          ?? generatedArtifacts.find((item) => item.step_id === event.step)
                        : undefined;
                      return (
                        <TimelineEvent
                          key={event.seq}
                          event={event}
                          step={step}
                          artifact={artifact}
                          preview={artifact ? artifactPreviews[artifact.id] : undefined}
                          onPreview={(path) => setLightbox({ images: [path], index: 0 })}
                        />
                      );
                    })}
                  </div>
                )}

                {htmlRun && run.snapshot.renderManifest && generatedArtifacts.length > 0 && (
                  <div className="rounded-lg border border-edge bg-panel p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-ink">离线渲染结果</div>
                        <div className="mt-1 text-[10px] text-muted">
                          文档 {run.snapshot.renderManifest.document.widthDevicePx} × {run.snapshot.renderManifest.document.heightDevicePx}px
                          · {generatedArtifacts.length} 张 · {run.snapshot.renderManifest.renderMs}ms
                        </div>
                      </div>
                      <span className="max-w-64 truncate rounded bg-black/20 px-2 py-1 text-[9px] text-muted" title={run.snapshot.renderManifest.rendererFingerprint}>
                        {run.snapshot.renderManifest.rendererFingerprint}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {generatedArtifacts.map((artifact) => {
                        const preview = artifactPreviews[artifact.id];
                        const output = run.snapshot.renderManifest?.outputs.find((item) => item.artifactId === artifact.id);
                        return (
                          <button
                            key={artifact.id}
                            type="button"
                            disabled={!preview}
                            onClick={() => preview && setLightbox({ images: generatedArtifacts.map((item) => artifactPreviews[item.id]?.path).filter((path): path is string => !!path), index: Math.max(0, generatedArtifacts.filter((item) => !!artifactPreviews[item.id]).findIndex((item) => item.id === artifact.id)) })}
                            className="overflow-hidden rounded-md border border-edge bg-black/20 text-left disabled:opacity-60"
                          >
                            {preview ? <img src={convertFileSrc(preview.path)} alt={artifactRoleLabel(artifact.role)} className="h-36 w-full object-contain" /> : <div className="flex h-36 items-center justify-center text-[10px] text-muted">校验下载中…</div>}
                            <div className="border-t border-edge px-2 py-1.5 text-[10px] text-muted">
                              {artifactRoleLabel(artifact.role)}{output?.index != null ? ` ${output.index + 1}` : ""}
                              {output && <span> · {output.clipDevicePx.width} × {output.clipDevicePx.height}px</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {htmlRun && ["awaiting_result_feedback", "succeeded"].includes(run.status) && generatedArtifacts.length === 0 && (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/8 p-3 text-xs text-amber-200">
                    云端截图内容已过期或清理；若此前已接受，仍可在本地素材库查看已入库副本。
                  </div>
                )}

                {run.status === "failed" && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-3 text-xs text-red-300">
                    {cloudAgentFailureMessage(run.snapshot.run.safe_message)}
                  </div>
                )}
                {run.status === "succeeded" && (
                  <div className="rounded-lg border border-lime/25 bg-lime/8 p-3 text-xs text-lime">
                    结果已接受并完成结算{ingestComplete ? "，全部产物已作为同一组加入素材库" : ingestFailed ? "，部分产物入库未完成" : "，正在校验并整组入库"}。
                    {ingestFailed && (
                      <button type="button" onClick={() => { reconciledIngest.current.delete(run.runId); setIngestFailed(false); setIngestRetry((value) => value + 1); }} className="ml-2 underline underline-offset-2 hover:text-white">
                        重新入库
                      </button>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
                  <span>会话 {run.conversationId.slice(0, 8)}</span>
                  <span>最大预算 {run.snapshot.run.budget_credits} 积分</span>
                  {run.snapshot.run.actual_credits != null && <span>实际结算 {run.snapshot.run.actual_credits} 积分</span>}
                </div>
                {error && <div className="rounded-lg bg-red-500/10 p-3 text-xs text-red-300">{error}</div>}
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-edge bg-panel p-4">
          {run.status === "awaiting_result_feedback" ? (
            <div className="mx-auto max-w-3xl">
              {!htmlRun && <textarea
                value={feedback}
                onChange={(event) => setFeedback(event.target.value.slice(0, 2000))}
                placeholder="可选：具体说明哪里不满意。Agent 会先诊断，再提交新的修订计划供你批准。"
                className="min-h-16 w-full resize-y rounded-md bg-black/25 px-3 py-2 text-xs text-ink outline-none ring-1 ring-edge focus:ring-accent"
              />}
              {htmlRun && <p className="text-xs leading-5 text-muted">请检查整图与切片。接受后会按会话、角色和切片顺序幂等入库；放弃则不会继续导出。</p>}
              <div className="mt-2 flex gap-2">
                <button disabled={busy} onClick={() => void submitFeedback("accept")} className="flex items-center gap-1.5 rounded-md bg-lime/90 px-4 py-2 text-xs font-semibold text-black disabled:opacity-50">
                  <Check size={13} /> 接受结果
                </button>
                {htmlRun ? (
                  <button disabled={busy} onClick={() => void cancel()} className="flex items-center gap-1.5 rounded-md border border-edge px-4 py-2 text-xs text-ink disabled:opacity-50">
                    <XCircle size={13} /> 放弃结果
                  </button>
                ) : (
                  <button disabled={busy} onClick={() => void submitFeedback("retry")} className="flex items-center gap-1.5 rounded-md border border-edge px-4 py-2 text-xs text-ink disabled:opacity-50">
                    <RefreshCw size={13} /> 提交修订意见
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl items-center justify-between">
              <span className="text-[10px] text-muted">收起会话不会中断任务；可从侧栏生成会话列表重新打开。</span>
              {canCancel && (
                <button disabled={busy} onClick={() => void cancel()} className="flex items-center gap-1.5 text-xs text-muted hover:text-red-300 disabled:opacity-50">
                  <XCircle size={13} /> 取消 Run
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      </div>
      {lightbox && (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(index) => setLightbox({ ...lightbox, index })}
        />
      )}
    </>
  );
}
