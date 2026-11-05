import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import type { Asset, GenJob } from "../lib/types";
import { useStore } from "../store";
import { canStartAnotherJob, canUseGenerationProvider } from "../lib/entitlement";
import { canonicalProviderKey, isCloudProvider } from "../lib/genProviders";
import { resolveImagePreviewJob } from "../lib/imagePreviewContinuation";
import { userErrorMessage } from "../lib/userError";

export function ImagePreviewContinuation({ asset, job, sourceJobId, enabled, onSent }: {
  asset: Asset; job: GenJob; sourceJobId: string | null; enabled: boolean; onSent: (jobId: string) => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const revision = useRef(0);
  const entitlement = useStore(state => state.cloudEntitlement);
  const auth = useStore(state => state.cloudAuth);
  const codex = useStore(state => state.codexHealth);
  const dreamina = useStore(state => state.dreaminaHealth);
  const runningCount = useStore(state => Object.values(state.genJobs).filter(item => item.running).length);
  const last = job.turns[job.turns.length - 1];
  const rawProvider = last?.provider || job.provider || "codex";
  const provider = rawProvider === "dreamina" ? "jimeng" : rawProvider === "codex-cli" ? "codex" : canonicalProviderKey(rawProvider);
  const cloud = isCloudProvider(provider);
  const health = provider === "jimeng" ? dreamina : codex;
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const unavailable = !job.sessionId ? "此图片未保存可续接的会话"
    : !canUseGenerationProvider(entitlement, provider) ? "当前账号不可使用此生成模型"
    : cloud ? !auth?.logged_in ? "请先登录 Bowerbird Cloud" : !auth.cloud_available ? "Bowerbird Cloud 暂不可用" : balance <= 0 ? "积分不足" : ""
    : !health?.ok ? userErrorMessage(health?.reason, "请在设置中检查生成服务的登录状态") : "";
  const blocked = unavailable || (!canStartAnotherJob(entitlement, runningCount) ? "已达当前账号档位的并行生成上限" : "");
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
      const lastTurn = latest.turns[latest.turns.length - 1];
      const nextProvider = lastTurn?.provider || latest.provider || "codex";
      const operation = useStore.getState().sendGenRevise(latest.id, text.trim(), canonicalProviderKey(nextProvider === "dreamina" ? "jimeng" : nextProvider), {
        rawPrompt: text.trim(), ratio: lastTurn?.ratio ?? latest.lastRatio,
        creativeRelation: "continued",
      });
      if (useStore.getState().genJobs[latest.id]?.turns.length > previousTurns) { setText(""); onSent(latest.id); }
      await operation;
    } catch (reason) {
      if (current()) setError(userErrorMessage(reason, "暂时无法继续这段会话，请重试"));
    } finally {
      sending.current = false;
      if (current()) setPending(false);
    }
  }
  return <form className="creation-image-preview-reply" aria-label="继续当前会话" onSubmit={event => { event.preventDefault(); void send(); }}>
    <textarea aria-label="续轮对话" placeholder="继续对话…" rows={3} value={text} disabled={pending}
      onChange={event => { setText(event.target.value); setError(""); }}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }}/>
    <div className="creation-image-preview-reply-actions">
      <span role={error ? "alert" : "status"}>{error || (job.running ? "生成中…" : pending ? "正在接续会话…" : blocked)}</span>
      {job.running && sourceJobId ? <button type="button" aria-label="停止当前会话生成" title="停止生成"
        onClick={() => useStore.getState().cancelGeneration(sourceJobId)}><Square size={14}/></button>
        : <button type="submit" aria-label="发送续轮对话" title={blocked || "发送（Ctrl / ⌘ + Enter）"} disabled={pending || !!blocked || !text.trim()}><Send size={16}/></button>}
    </div>
  </form>;
}
