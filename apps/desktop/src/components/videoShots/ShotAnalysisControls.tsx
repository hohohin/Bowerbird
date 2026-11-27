import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "../ModalShell";
import { BcoinAmount } from "../BcoinAmount";
import { userErrorMessage } from "../../lib/userError";
import type { Shot } from "../../lib/videoShots";
import { useStore } from "../../store";

type Quote = {
  sourceHash: string; planRevision: number; owner: string; shotIds: string[]; rerun: boolean; pricingVersion: number; totalMilli: number; expiresAt: number;
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

export function ShotAnalysisAction({ assetId, sourceHash, revision, shots, rerun = false, jobs, disabled, pendingEdits }: {
  assetId: string; sourceHash: string; revision: number; shots: Shot[]; rerun?: boolean;
  jobs: ReturnType<typeof useShotJobs>; disabled: boolean; pendingEdits: boolean;
}) {
  const ids = shots.map(s => s.id).join(",");
  const owner = useStore(s => s.cloudAuth?.logged_in ? s.cloudAuth.user_id : null);
  const [open,setOpen] = useState(false), [busy,setBusy] = useState(false);
  const [record,setRecord] = useState<{ key: string; quote?: Quote; error?: string }>();
  const [actionError,setActionError] = useState("");
  const [expiredQuote,setExpiredQuote] = useState<Quote>();
  const [retry,setRetry] = useState(0);
  const state = jobs.progress;
  const quoteKey = JSON.stringify([assetId,sourceHash,revision,owner,ids,rerun,retry]);
  const canQuote = !!ids && !!owner && !jobs.locked && (!rerun || open);
  const current = canQuote && record?.key === quoteKey ? record : undefined;
  const quote = current?.quote;
  const valid = quote && quote !== expiredQuote && quote.expiresAt > Date.now();
  const error = actionError || current?.error || (quote && !valid ? "报价已过期，请重新获取报价。" : "");
  useEffect(() => {
    let live = true;
    setRecord(undefined);
    if (!canQuote) return;
    const timer = setTimeout(() => {
      void invoke<Quote>("video_shots_quote",{assetId,sourceHash,shotIds:ids.split(","),rerun}).then(q => {
        if (!live) return;
        if (q.shotIds.join(",") !== ids || q.sourceHash !== sourceHash || q.owner !== owner || q.planRevision !== revision ||
            q.rerun !== rerun || !Number.isSafeInteger(q.totalMilli) || q.totalMilli < 0 || !Number.isSafeInteger(q.expiresAt)) {
          setRecord({ key: quoteKey, error: "镜头或账号已变更，请重新获取报价。" });
          return;
        }
        setRecord({ key: quoteKey, quote: q });
      }).catch(e => { if (live) setRecord({ key: quoteKey, error: userErrorMessage(e,"无法取得镜头报价，请重试。") }); });
    }, rerun ? 0 : 150);
    return () => { live = false; clearTimeout(timer); };
  }, [assetId,sourceHash,revision,owner,ids,rerun,quoteKey,canQuote]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(() => setExpiredQuote(quote), Math.max(0, quote.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);
  function requote() {
    setActionError("");
    setRetry(n => n + 1);
  }
  async function run(action: "start" | "stop" | "resume") {
    if (busy || (action === "start" && (!valid || disabled || pendingEdits || jobs.locked))) return;
    if (action === "start" && quote!.expiresAt <= Date.now()) {
      setExpiredQuote(quote);
      return;
    }
    setBusy(true);
    setActionError("");
    try { await jobs.action(action, action === "start" ? quote : undefined); setOpen(false); }
    catch (e) {
      const message = userErrorMessage(e,"镜头任务未完成，请查看原任务状态。");
      if (action === "start") setRecord({ key: quoteKey, error: message });
      else setActionError(message);
    }
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
      onClick={() => { if (current && !valid) requote(); else setActionError(""); setOpen(true); }}>
      {rerun ? "重新分析本镜" : "分析选中镜头"}{!rerun && valid && <> · <BcoinAmount amount={quote.totalMilli / 1000}/></>}
    </button>
    {!rerun && !owner && <span role="status">登录后可分析镜头</span>}
    {error && !open && <span role="alert">{error}</span>}
    {open && <ModalShell title={rerun ? "确认重新分析本镜" : "确认分析选中镜头"} width="sm" preventClose={busy} onClose={() => setOpen(false)} footer={<>
      <button type="button" className="app-modal-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      {error && !valid ? <button type="button" className="app-modal-button is-primary" onClick={requote}>重新获取报价</button>
        : <button type="button" className="app-modal-button is-primary" disabled={!valid || busy || disabled || pendingEdits || jobs.locked} onClick={() => void run("start")}>{rerun ? "确认重新分析" : "确认分析"}</button>}
    </>}>
      {rerun && shots[0] && <p>镜头 {String(shots[0].index + 1).padStart(2,"0")} 的新结果会替换已有的画面描述和两项提示词。</p>}
      <p role="status">{valid ? <>提交 {shots.length} 个镜头 · {(shots.reduce((n,s) => n + s.end - s.start,0) / 1000).toLocaleString("zh-CN")} 秒 · <BcoinAmount amount={quote.totalMilli / 1000}/></> : error || (!owner ? "登录后可分析镜头" : !ids ? "请选择要分析的镜头" : "正在获取报价…")}</p>
    </ModalShell>}
  </>;
}
