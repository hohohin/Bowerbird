import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, History, MessageCircle, RotateCcw } from "lucide-react";
import type { WorkflowRun, H3CardPrompt } from "../../lib/canvasWorkflow";
import { ModalShell } from "../ModalShell";
import { H3OptimizeButton } from "./H3OptimizeButton";
import { H3PromptPreview } from "./H3PromptPreview";
import "./H3OptimizationActions.css";

export function H3OptimizationActions({ nodeId, runs, disabled, busy, retryDisabled, restoreDisabled, onOptimize, onRetry, onRestore, onFocusPrompt, onContinue, draft, stale, seconds, onUpdate, readText }: {
  nodeId: string; runs: WorkflowRun[]; disabled: boolean; busy?: boolean; retryDisabled: boolean;
  onOptimize: () => void; onRetry: () => void;
  restoreDisabled: boolean; onRestore: (runId: string, source: "original" | "result") => Promise<boolean>;
  onFocusPrompt: (source: "original" | "result") => void;
  onContinue: (runId: string) => void;
  draft?: H3CardPrompt; stale: boolean; seconds?: number; onUpdate: (changes: Partial<H3CardPrompt>) => void; readText: () => string;
}) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const focusAfterRestore = useRef<"original" | "result" | null>(null);
  useEffect(() => {
    if (open || !focusAfterRestore.current) return;
    // The modal restores focus to its trigger on unmount. Focus the prompt after that cleanup.
    onFocusPrompt(focusAfterRestore.current);
    focusAfterRestore.current = null;
  }, [open, onFocusPrompt]);

  async function restore(runId: string, source: "original" | "result") {
    setRestoring(true);
    try {
      if (await onRestore(runId, source)) {
        focusAfterRestore.current = source;
        setOpen(false);
      }
    } finally {
      setRestoring(false);
    }
  }

  const history = [...runs].reverse().filter(run => run.steps[nodeId]?.comfyOptimization);
  const canRetry = history.some(run => !run.steps[nodeId].comfyAutoGeneration);
  const continuation = history.find(run => {
    const snapshot = run.steps[nodeId].comfyOptimization;
    return snapshot?.result && snapshot.dshContinuation;
  });
  const status = !draft ? "未生成" : draft.paused ? "已停用" : stale ? "需重新优化提示词" : draft.edited !== undefined ? "已微调" : "已生效";
  const pauseLabel = draft?.paused ? "恢复使用优化后提示词" : "暂停使用优化后提示词";
  return <section className="h3-optimized-module" aria-label="优化后提示词" data-state={status} onPointerDown={event => event.stopPropagation()}>
    <div className="h3-optimization-actions">
    <div className="h3-opt-heading"><strong>优化后提示词</strong><small>{status}</small></div>
    <H3OptimizeButton disabled={disabled} busy={busy} busyLabel="正在优化提示词" iconOnly repeat={!!draft} onClick={onOptimize} />
    {draft && <button type="button" className="h3-optimization-icon" aria-label={pauseLabel} title={pauseLabel} disabled={restoreDisabled}
      onClick={() => onUpdate({ paused: !draft.paused, expanded: false })}>{draft.paused ? <Eye size={14} /> : <EyeOff size={14} />}</button>}
    <button type="button" className="h3-optimization-icon" aria-label="查看提示词优化历史" title="查看提示词优化历史"
      onClick={() => setOpen(true)}><History size={14} /></button>
    <button type="button" className="h3-optimization-icon" aria-label="续聊优化提示词"
      title={continuation ? "打开最近一次优化的 DSH · Cloud 对话"
        : history.some(run => run.steps[nodeId].comfyOptimization?.result) ? "已有优化记录未保存可续接会话" : "完成一次优化后可续聊"}
      disabled={!continuation} onClick={() => continuation && onContinue(continuation.id)}><MessageCircle size={14} /></button>
    </div>
    {draft ? <H3PromptPreview draft={draft} seconds={seconds} disabled={restoreDisabled} update={onUpdate} readText={readText} />
      : <p className="h3-opt-empty">暂无优化结果 · 可优化提示词，或直接运行原文</p>}
    {open && <ModalShell title="提示词优化历史" width="md" preventClose={restoring} onClose={() => setOpen(false)}>
      <div className="h3-optimization-history">
        {canRetry && <button type="button" className="h3-history-retry" aria-label="重试优化提示词" disabled={retryDisabled || busy}
          onClick={() => { setOpen(false); onRetry(); }}><RotateCcw size={13} />按上次原文重试优化</button>}
        {!history.length && <p>暂无优化记录</p>}
        {history.map((run, index) => {
          const snapshot = run.steps[nodeId].comfyOptimization!;
          const canRestore = !run.steps[nodeId].comfyAutoGeneration || !!snapshot.inputBindings;
          return <section key={run.id}>
            <h3>第 {history.length - index} 次优化</h3>
            <div className="h3-history-heading"><h4>用户原文</h4>{canRestore && <button type="button" disabled={restoreDisabled || restoring} aria-label={`恢复第 ${history.length - index} 次用户原文`} onClick={() => void restore(run.id, "original")}>恢复到原文</button>}</div><p>{snapshot.input.prompt}</p>
            <div className="h3-history-heading"><h4>优化结果</h4>{canRestore && snapshot.result !== undefined && <button type="button" disabled={restoreDisabled || restoring} aria-label={`恢复第 ${history.length - index} 次优化结果`} onClick={() => void restore(run.id, "result")}>恢复到优化后提示词</button>}</div><p>{snapshot.result ?? (run.status === "running" ? "正在优化…" : run.status === "waiting" ? "等待取回结果" : run.status === "stopped" ? "已停止" : "未返回优化结果")}</p>
          </section>;
        })}
      </div>
    </ModalShell>}
  </section>;
}
