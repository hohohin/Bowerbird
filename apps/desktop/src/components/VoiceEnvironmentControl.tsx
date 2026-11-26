import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ModalShell } from "./ModalShell";
import { voiceApi, voiceScope, type VoiceConfig, type VoiceEnvironment } from "../lib/voice";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import "./ComfyVideoCard.css";

type Snapshot = { scope: string; environment: VoiceEnvironment | null; acting: boolean };
const empty: Snapshot = { scope: "", environment: null, acting: false };
let snapshot = empty;
let pendingProbe: Promise<void> | undefined;
let pendingAction: Promise<void> | undefined;
let revision = 0;
let lastFocusCheck = -Infinity;
const focusInterval = 5000;
const listeners = new Set<() => void>();
const currentScope = (scope: string) => voiceScope(useStore.getState()) === scope;
const installSteps = { resources: 1, python: 2, pytorch: 3, voxcpm: 4, cuda_check: 5 };
function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function selectScope(scope: string) {
  if (snapshot.scope === scope) return;
  revision++;
  pendingProbe = undefined;
  lastFocusCheck = -Infinity;
  publish({ scope, environment: null, acting: !!pendingAction });
}
function accept(scope: string, at: number, environment: VoiceEnvironment) {
  if (at === revision && currentScope(scope)) publish({ ...snapshot, environment });
}
async function detect(scope: string, action: "status" | "check") {
  if (!currentScope(scope)) return;
  selectScope(scope);
  if (pendingAction) {
    await pendingAction.catch(() => {});
    return detect(scope, action);
  }
  if (pendingProbe) return pendingProbe;
  const at = revision;
  const probe = voiceApi.environment(action).then(next => accept(scope, at, next), error => {
    if (at === revision && currentScope(scope)) throw error;
  }).finally(() => {
    if (pendingProbe === probe) pendingProbe = undefined;
  });
  pendingProbe = probe;
  return probe;
}
async function changeEnvironment(scope: string, work: () => Promise<VoiceEnvironment | undefined>) {
  if (pendingAction || !currentScope(scope)) return;
  selectScope(scope);
  const at = ++revision;
  pendingProbe = undefined;
  const action = Promise.resolve().then(() => currentScope(scope) ? work() : undefined).then(next => {
    if (next) accept(scope, at, next);
  }).finally(() => {
    pendingAction = undefined;
    publish({ ...snapshot, acting: false });
  });
  pendingAction = action;
  publish({ ...snapshot, acting: true });
  return action;
}
export function VoiceEnvironmentControl({ projectId, onStatusChange }: { projectId: string; onStatusChange?: (message: string | null) => void }) {
  const scope = useStore(voiceScope);
  const { environment: state, acting } = useSyncExternalStore(subscribe, () => snapshot.scope === scope ? snapshot : empty);
  const [show, setShow] = useState(false), [localBusy, setBusy] = useState(false), [error, setError] = useState("");
  const [config, setConfig] = useState<VoiceConfig>({ python: "", model: "" });
  const [advanced, setAdvanced] = useState(false);
  const dot = useRef<HTMLButtonElement>(null);
  const busy = localBusy || acting;
  const ready = state?.phase === "ready", installing = state?.phase === "installing";
  const message = state?.message;
  const step = state?.install_step && installSteps[state.install_step];
  const percent = state?.progress_percent ?? undefined;
  const seconds = state?.active_seconds;
  useEffect(() => { onStatusChange?.(ready ? null : error || message || "正在检查本机配音环境…"); }, [ready, error, message, onStatusChange]);
  const close = () => { setShow(false); dot.current?.focus(); };
  useEffect(() => { setShow(false); setConfig({ python: "", model: "" }); setError(""); setBusy(false); setAdvanced(false); }, [scope]);
  useEffect(() => {
    let active = true;
    const check = () => void detect(scope, installing ? "status" : "check").catch(e => {
      if (active) setError(userErrorMessage(e, "配音环境检测失败"));
    });
    check();
    const timer = installing ? setInterval(check, 1200) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [installing, scope]);
  useEffect(() => {
    let active = true;
    const focus = () => {
      const now = performance.now();
      if (!currentScope(scope) || pendingAction || installing || (ready && !show) || now - lastFocusCheck < focusInterval) return;
      lastFocusCheck = now;
      void detect(scope, "check").catch(e => { if (active) setError(userErrorMessage(e, "配音环境检测失败")); });
    };
    window.addEventListener("focus", focus);
    return () => { active = false; window.removeEventListener("focus", focus); };
  }, [installing, ready, show, scope]);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); }
    catch (e) { if (currentScope(scope)) setError(userErrorMessage(e, "配音环境操作失败")); }
    finally { if (currentScope(scope)) setBusy(false); }
  }
  useEffect(() => { if (installing) setAdvanced(false); }, [installing]);
  const previous = useRef(ready);
  useEffect(() => { if (ready && !previous.current && show) close(); previous.current = ready; }, [ready, show]);
  return <>
    <button ref={dot} type="button" className={`comfy-environment-dot${ready ? " is-ready" : ""}`} aria-label="配音环境" aria-haspopup="dialog"
      title={error || state?.message || "正在检测配音环境"} onClick={() => {
        setShow(true);
        if (!installing) void detect(scope, "check").catch(e => { if (currentScope(scope)) setError(userErrorMessage(e, "配音环境检测失败")); });
      }}><span aria-hidden="true" /></button>
    {show && <ModalShell title="本机配音环境" onClose={close} width="sm" className="voice-environment-dialog">
      <div onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        <p role="status">{step ? `第 ${step} 步，共 5 步 · ` : ""}{message || "正在检测…"}</p>
        {state?.gpu && <small>{state.gpu}</small>}
        {installing && <>
          <progress aria-label="安装进度"
            value={percent ?? (state.completed_bytes < state.total_bytes ? state.completed_bytes : undefined)}
            max={percent === undefined ? state.total_bytes || 1 : 100} />
          {percent !== undefined && <small>{percent}%{seconds ? ` · 当前安装进程已运行 ${seconds} 秒` : ""}</small>}
        </>}
        <div className="voice-card-actions">
          <button disabled={busy || installing} title={state?.directory} onClick={() => void act(() => changeEnvironment(scope, async () => {
            const path = await open({ directory: true, multiple: false });
            if (typeof path === "string" && currentScope(scope)) return voiceApi.environment("check", path);
          }))}>安装位置</button>
          <button disabled={busy || (!installing && !state?.can_install && !ready)} onClick={() => void act(() => changeEnvironment(scope,
            () => voiceApi.environment(installing ? "pause" : ready ? "recheck" : "install"),
          ))}>{installing ? "暂停" : ready ? "重新检测" : state?.phase === "paused" || state?.phase === "failed" ? "继续准备" : "下载并启用"}</button>
        </div>
        {!installing && <details open={advanced} onToggle={e => {
          const expanded = e.currentTarget.open; setAdvanced(expanded);
          if (expanded) void act(async () => {
            const saved = (await voiceApi.snapshot(projectId, { historyLimit: 0 })).config;
            if (currentScope(scope)) setConfig(saved);
          });
        }}><summary>连接已有环境</summary>{(["python", "model"] as const).map(field => <button key={field} disabled={busy} title={config[field]} onClick={() => void act(async () => {
          const path = await open({ directory: field === "model", multiple: false });
          if (typeof path === "string" && currentScope(scope)) setConfig(c => ({ ...c, [field]: path }));
        })}>{field === "python" ? "选择 Python" : "选择模型目录"}</button>)}
          <button disabled={busy || !config.python || !config.model} onClick={() => void act(() => changeEnvironment(scope, async () => {
            await voiceApi.configure(config);
            if (currentScope(scope)) return voiceApi.environment("recheck");
          }))}>连接并检查</button>
        </details>}
        {error && <p role="alert">{error}</p>}
      </div>
    </ModalShell>}
  </>;
}
