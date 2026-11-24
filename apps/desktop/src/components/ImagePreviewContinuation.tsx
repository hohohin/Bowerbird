import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import type { Asset, GenJob } from "../lib/types";
import { useStore } from "../store";
import { canStartAnotherJob, countLimitedGenerationJobs } from "../lib/entitlement";
import { normalizeGenerationProvider } from "../lib/genProviders";
import { generationProviderIssue } from "../lib/generationAvailability";
import { ProviderIssueNotice } from "./creation/ProviderIssueNotice";
import { loadImagePreviewHistory, resolveImagePreviewJob } from "../lib/imagePreviewContinuation";
import { userErrorMessage } from "../lib/userError";

export function ImagePreviewContinuation({ asset, job, sourceJobId, parentNodeId, enabled, compact, draft, onSent }: {
  asset: Asset;
  job: GenJob;
  sourceJobId: string | null;
  parentNodeId?: string | null;
  enabled: boolean;
  compact?: boolean;
  draft?: { value: string; onChange: (value: string) => void };
  onSent: (jobId: string, turnKey?: string) => void;
}) {
  const [localText, setLocalText] = useState("");
  const text = draft?.value ?? localText;
  const setText = draft?.onChange ?? setLocalText;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const revision = useRef(0);
  const entitlement = useStore(state => state.cloudEntitlement);
  const auth = useStore(state => state.cloudAuth);
  const codex = useStore(state => state.codexHealth);
  const dreamina = useStore(state => state.dreaminaHealth);
  const runningCount = useStore(state => countLimitedGenerationJobs(state.genJobs));
  const selectedTurn = job.turns.find(turn => !!asset.store_path && turn.images.includes(asset.store_path));
  const rawProvider = selectedTurn?.provider || job.provider || "codex";
  const provider = normalizeGenerationProvider(rawProvider);
  const issue = job.sessionId ? generationProviderIssue(provider, { cloudAuth: auth, cloudEntitlement: entitlement, codexHealth: codex, dreaminaHealth: dreamina }) : null;
  const unavailable = job.sessionId ? issue?.message : "此图片未保存可续接的会话";
  const blocked = unavailable || (!canStartAnotherJob(entitlement, runningCount, provider) ? "已达当前账号档位的并行生成上限" : "");
  useEffect(() => () => { revision.current++; }, [asset.id, enabled]);

  async function send() {
    if (!enabled || sending.current || job.running || blocked || !text.trim()) return;
    sending.current = true; setPending(true); setError("");
    const token = revision.current, route = useStore.getState().projectRouteRevision;
    const current = () => token === revision.current && route === useStore.getState().projectRouteRevision;
    try {
      const resolved = await resolveImagePreviewJob(asset, job, sourceJobId);
      if (!current()) return;
      // Recovery may have found a running job or a newer turn while this input was being composed.
      const latest = useStore.getState().genJobs[resolved.id] ?? resolved;
      if (latest.running) throw new Error("这段会话仍在生成，请等待完成后继续");
      if (!latest.sessionId) throw new Error("此图片未保存可续接的会话");
      useStore.setState(state => state.genJobs[latest.id] ? {} : {
        genJobs: { ...state.genJobs, [latest.id]: latest }, genJobOrder: [...state.genJobOrder, latest.id],
      });
      const previousTurns = latest.turns.length;
      const path = asset.store_path;
      const origin = latest.turns.find(turn => !!path && turn.images.includes(path)) ?? selectedTurn;
      const lastOutput = [...latest.turns].reverse().find(turn => turn.images.length > 0);
      const historical = !!path && !!lastOutput && !lastOutput.images.includes(path);
      const exactImage = !!path && (historical || lastOutput?.images.length !== 1);
      const nextProvider = origin?.provider || latest.provider || "codex";
      const operation = useStore.getState().sendGenRevise(latest.id, text.trim(), normalizeGenerationProvider(nextProvider), {
        rawPrompt: text.trim(), ratio: origin?.ratio ?? latest.lastRatio,
        ...(path ? { parentAssetPath: path, parentNodeId: parentNodeId ?? null } : {}),
        ...(exactImage ? { exactReferences: [path], referenceNodeIds: [parentNodeId ?? null] } : {}),
        creativeRelation: historical ? "branch" : "continued",
      });
      const submitted = useStore.getState().genJobs[latest.id]?.turns[previousTurns];
      if (submitted) { setText(""); onSent(latest.id, submitted.turnKey); }
      await operation;
    } catch (reason) {
      if (current()) setError(userErrorMessage(reason, "暂时无法继续这段会话，请重试"));
    } finally {
      sending.current = false;
      if (current()) setPending(false);
    }
  }
  return <form className={`creation-image-preview-reply${compact ? " is-compact" : ""}`} aria-label="继续当前会话" onSubmit={event => { event.preventDefault(); void send(); }}>
    <textarea aria-label="续轮对话" placeholder="基于当前图继续修改…" rows={compact ? 1 : 3} value={text} disabled={pending}
      onChange={event => { setText(event.target.value); setError(""); }}
      onKeyDown={event => {
        if ((compact || event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }}/>
    {!job.running && !pending && <ProviderIssueNotice issue={issue} />}
    <div className="creation-image-preview-reply-actions">
      <span role={error ? "alert" : "status"}>{error || (job.running ? "生成中…" : pending ? "正在接续生成记录…" : !issue && (blocked || (job.projectId ? "新图将加入画布" : "")))}</span>
      {job.running && sourceJobId ? <button type="button" aria-label="停止当前会话生成" title="停止生成"
        onClick={() => useStore.getState().cancelGeneration(sourceJobId)}><Square size={14}/></button>
        : <button type="submit" aria-label="发送续轮对话" title={blocked || "发送（Ctrl / ⌘ + Enter）"} disabled={pending || !!blocked || !text.trim()}><Send size={16}/></button>}
    </div>
  </form>;
}

export function CanvasImageContinuation({ asset, projectId, job, parentNodeId, onSent, onUnavailable }: {
  asset: Asset;
  projectId: string | null;
  job?: GenJob;
  parentNodeId?: string | null;
  onSent: (jobId: string) => void;
  onUnavailable?: () => void;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ assetId: string; job: GenJob | null; error?: string }>();
  const liveJob = useStore(state => job && state.genJobs[job.id]);
  useEffect(() => {
    if (job) return;
    let current = true;
    void loadImagePreviewHistory(asset, projectId).then(history => {
      if (current) setResult({ assetId: asset.id, job: history });
    }).catch(reason => {
      if (current) setResult({ assetId: asset.id, job: null, error: userErrorMessage(reason, "生成记录暂时无法读取") });
    });
    return () => { current = false; };
  }, [asset.id, asset.generation_session_id, job?.id, projectId, retry]);
  const ready = result?.assetId === asset.id ? result : undefined;
  const source = liveJob ?? job ?? ready?.job;
  if (source?.sessionId) return <ImagePreviewContinuation key={asset.id} asset={asset} job={source}
    sourceJobId={job?.id ?? null} parentNodeId={parentNodeId} enabled compact onSent={onSent}/>;
  if (ready?.error) return <div role="alert">{ready.error} <button type="button" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>重试</button></div>;
  if (!job && !ready) return <div role="status">正在读取生成记录…</div>;
  return <div role="status">此图片未保存可续接的会话{onUnavailable && <button type="button" onClick={onUnavailable}>基于此图创作</button>}</div>;
}
