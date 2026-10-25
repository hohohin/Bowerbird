import { userErrorMessage } from "../../lib/userError";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

export function DreaminaTaskDiagnostics({ submitId }: { submitId?: string | null }) {
  const [result, setResult] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const revision = useRef(0);
  useEffect(() => { revision.current++; setBusy(false); setCopied(false); }, [submitId]);
  useEffect(() => () => { revision.current++; }, []);
  async function query() {
    if (!submitId || busy) return;
    const version = ++revision.current;
    setBusy(true); setCopied(false);
    try {
      const report = await api.dreaminaTaskDiagnostics(submitId);
      if (revision.current === version) setResult({ id: submitId, text: JSON.stringify(report, null, 2) });
    } catch (error) {
      if (revision.current === version) setResult({ id: submitId, text: `诊断查询失败：${userErrorMessage(error, "暂时无法取得诊断信息，请稍后重试。")}\n原生成任务状态未改变。` });
    } finally { if (revision.current === version) setBusy(false); }
  }
  const text = result && result.id === submitId ? result.text : null;
  return <div className="space-y-2 text-xs" data-dreamina-diagnostics>
    <button type="button" disabled={!submitId || busy} onClick={() => void query()}
      className="rounded bg-panel2 px-2.5 py-1 text-ink disabled:opacity-50">
      {busy ? "正在查询诊断信息…" : "查询诊断信息"}
    </button>
    <p className="text-muted">{submitId ? "供技术支持排查问题使用；只查询已有任务，不会重新生成。" : "提交未返回任务编号，无法查询远端任务；请查看上方提交错误。"}</p>
    {text && <>
      <button type="button" className="text-accent underline" onClick={() => void navigator.clipboard.writeText(text)
        .then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "已复制诊断" : "复制完整诊断"}</button>
      <pre aria-label="完整错误诊断" className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-panel p-2 text-[11px] text-ink">{text}</pre>
    </>}
  </div>;
}
