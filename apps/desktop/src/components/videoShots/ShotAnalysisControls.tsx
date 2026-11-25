import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "../ModalShell";
import { BcoinAmount } from "../BcoinAmount";
import { userErrorMessage } from "../../lib/userError";
import type { Shot } from "../../lib/videoShots";
import { useStore } from "../../store";

type Quote = {
  sourceHash: string; owner: string; shotIds: string[]; rerun: boolean; pricingVersion: number; totalMilli: number; expiresAt: number;
};
type Progress = {
  status: "idle" | "running" | "interrupted" | "stopped" | "completed" | "failed";
  remaining: string[]; stopping: boolean; error: string | null;
};
export function useShotJobs(assetId: string, sourceHash: string, onChange: () => void) {
  const [progress,setProgress] = useState<Progress>();
  const [error,setError] = useState("");
  const refresh = useRef(onChange);
  refresh.current = onChange;
  const version = useRef(0);
  const last = useRef("");
  const [reload,setReload] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const ticket = version.current;
      try {
        const next = await invoke<Progress>("video_shots_progress", {assetId,sourceHash});
        if (!live || ticket !== version.current) return;
        const signature = JSON.stringify(next);
        if (last.current && last.current !== signature) refresh.current();
        last.current = signature; setProgress(next); setError("");
        if (next.status !== "running") return;
      } catch (failure) { if (live) setError(userErrorMessage(failure,"无法读取分析进度，请重试。")); }
      if (live) timer = setTimeout(poll, 1100);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [assetId,sourceHash,reload]);
  async function action(name: "start" | "resume" | "stop", quote?: Quote) {
    version.current++;
    try {
      const next = await invoke<Progress>("video_shots_" + name, quote ? {assetId,quote} : {assetId,sourceHash});
      setProgress(next); setError(""); refresh.current();
    } finally { setReload(n => n + 1); }
  }
  return { progress, error, action, locked: !progress || !!error || ["running","interrupted"].includes(progress.status) };
}

export function ShotAnalysisAction({ assetId, sourceHash, shots, rerun = false, jobs, disabled }: {
  assetId: string; sourceHash: string; shots: Shot[]; rerun?: boolean; jobs: ReturnType<typeof useShotJobs>; disabled: boolean;
}) {
  const ids = shots.map(s => s.id).join(",");
  const owner = useStore(s => s.cloudAuth?.logged_in ? s.cloudAuth.user_id : null);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false);
  const [quote,setQuote] = useState<Quote>();
  const [error,setError] = useState("");
  const [retry,setRetry] = useState(0);
  const state = jobs.progress;
  useEffect(() => {
    let live = true;
    setQuote(undefined); setError("");
    if (!ids || (rerun && !open) || jobs.locked || !owner) return;
    const timer = setTimeout(() => {
      void invoke<Quote>("video_shots_quote",{assetId,sourceHash,shotIds:ids.split(","),rerun}).then(q => {
        if (!live) return;
        if (q.shotIds.join(",") !== ids || q.sourceHash !== sourceHash || q.owner !== owner) {
          setError("镜头或账号已变更，请重新打开复刻核对报价。");
          return;
        }
        setQuote(q);
      }).catch(e => { if (live) setError(userErrorMessage(e,"无法取得镜头报价，请重试。")); });
    }, open ? 0 : 150);
    return () => { live = false; clearTimeout(timer); };
  }, [assetId,sourceHash,owner,ids,rerun,open,retry,jobs.locked]);
  const valid = quote && quote.owner === owner && quote.sourceHash === sourceHash && quote.shotIds.join(",") === ids &&
    quote.rerun === rerun && Number.isSafeInteger(quote.totalMilli) && quote.totalMilli >= 0;
  async function run(action: "start" | "stop" | "resume") {
    if (busy || (action === "start" && (!valid || disabled))) return;
    if (action === "start" && quote!.expiresAt <= Date.now()) {
      setQuote(undefined); setError("报价已过期，请重新获取报价。"); return;
    }
    setBusy(true);
    try { await jobs.action(action, action === "start" ? quote : undefined); setOpen(false); }
    catch (e) { setError(userErrorMessage(e,"镜头任务未完成，请查看原任务状态。")); setQuote(undefined); }
    finally { setBusy(false); }
  }
  if (!rerun && state && ["interrupted","running"].includes(state.status)) return <>
    <span role="status">{jobs.error || state.error && userErrorMessage(state.error) || (state.status === "interrupted" ? "分析已中断" : state.stopping ? "当前镜头完成后停止" : "正在分析镜头")}</span>
    {state.status === "interrupted" ? <button type="button" className="app-button-secondary" disabled={busy} onClick={() => void run("resume")}>按原任务恢复</button>
      : <button type="button" className="app-button-secondary" disabled={busy || state.stopping} onClick={() => void run("stop")}>停止后续镜头</button>}
    {error && <span role="alert">{error}</span>}
  </>;
  return <>
    {!rerun && (jobs.error || state?.error || state?.status === "stopped") &&
      <span role="status">{jobs.error || (state?.error ? userErrorMessage(state.error) : "已停止后续镜头")}</span>}
    <button type="button" className={rerun ? "app-button-secondary" : "app-button-primary"} disabled={!ids || disabled || jobs.locked || !owner}
      onClick={() => { setQuote(undefined); setError(""); setOpen(true); }}>
      {rerun ? "重新分析本镜" : "分析选中镜头"}{!rerun && valid && <> · <BcoinAmount amount={quote.totalMilli / 1000}/></>}
    </button>
    {!rerun && !owner && <span role="status">登录后可分析镜头</span>}
    {error && !open && <span role="alert">{error}</span>}
    {open && <ModalShell title={rerun ? "确认重新分析本镜" : "确认分析选中镜头"} width="sm" preventClose={busy} onClose={() => setOpen(false)} footer={<>
      <button type="button" className="app-modal-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      {error && !valid ? <button type="button" className="app-modal-button is-primary" onClick={() => setRetry(n => n + 1)}>重新获取报价</button>
        : <button type="button" className="app-modal-button is-primary" disabled={!valid || busy || disabled || jobs.locked} onClick={() => void run("start")}>{rerun ? "确认重新分析" : "确认分析"}</button>}
    </>}>
      {rerun && <p>镜头 {String(shots[0].index + 1).padStart(2,"0")} 的新结果会替换已有的画面描述和两项提示词。</p>}
      <p role="status">{valid ? <>提交 {shots.length} 个镜头 · {(shots.reduce((n,s) => n + s.end - s.start,0) / 1000).toLocaleString("zh-CN")} 秒 · <BcoinAmount amount={quote.totalMilli / 1000}/></> : error || "正在获取报价…"}</p>
    </ModalShell>}
  </>;
}
