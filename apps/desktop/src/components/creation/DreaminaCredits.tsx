import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useStore } from "../../store";

function Credits({ submitId, revision, balance = false }: { submitId?: string | null; revision: string; balance?: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const key = `${balance}:${submitId}:${revision}:${refresh}`;
  const [result, setResult] = useState<{ key: string; value?: number | null; error?: string } | null>(null);
  useEffect(() => {
    if (!balance && !submitId) return;
    let active = true;
    const request = balance ? api.dreaminaCreditBalance() : api.dreaminaTaskCredit(submitId!);
    void request.then(value => { if (active) setResult({ key, value }); })
      .catch(error => { if (active) setResult({ key, error: String(error) }); });
    return () => { active = false; };
  }, [key, balance, submitId]);
  const current = result?.key === key ? result : null;
  const missingId = !balance && !submitId;
  const label = balance ? "即梦剩余" : "本次消耗";
  return <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-muted" aria-live="polite">
    <span title={current?.error}>{label}：{missingId ? "暂无任务编号" : current?.error ? "查询失败" : !current ? "查询中…" : current.value == null ? "官方暂未返回" : `${current.value.toLocaleString("zh-CN")} 积分`}</span>
    {!missingId && <button type="button" className="underline hover:text-ink disabled:opacity-40" aria-label={`刷新${label}积分`} disabled={!current} onClick={() => setRefresh(value => value + 1)}>刷新</button>}
  </span>;
}

export function DreaminaBalance() {
  const revision = useStore(state => Object.values(state.genJobs).filter(job => job.provider === "jimeng")
    .map(job => `${job.id}:${job.submitId}:${job.running}`).join("|"));
  return <Credits balance revision={revision} />;
}

export function DreaminaTaskCredit({ submitId, busy }: { submitId?: string | null; busy: boolean }) {
  return <Credits submitId={submitId} revision={String(busy)} />;
}
