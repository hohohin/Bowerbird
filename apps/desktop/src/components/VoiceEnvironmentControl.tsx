import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ModalShell } from "./ModalShell";
import { voiceApi, type VoiceConfig, type VoiceEnvironment } from "../lib/voice";
import { userErrorMessage } from "../lib/userError";
import "./ComfyVideoCard.css";

let environment: VoiceEnvironment | null = null;
let pending: Promise<VoiceEnvironment> | undefined;
const listeners = new Set<() => void>();
function publish(next: VoiceEnvironment) {
  environment = next;
  listeners.forEach(listener => listener());
  return next;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function detect(action = "status") {
  return pending ??= voiceApi.environment(action).then(publish).finally(() => { pending = undefined; });
}
export function VoiceEnvironmentControl({ projectId, onStatusChange }: { projectId: string; onStatusChange?: (message: string | null) => void }) {
  const state = useSyncExternalStore(subscribe, () => environment);
  const [show, setShow] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [config, setConfig] = useState<VoiceConfig>({ python: "", model: "" });
  const [advanced, setAdvanced] = useState(false);
  const dot = useRef<HTMLButtonElement>(null);
  const ready = state?.phase === "ready", installing = state?.phase === "installing";
  useEffect(() => { onStatusChange?.(ready ? null : error || state?.message || "正在检查本机配音环境…"); }, [ready, error, state, onStatusChange]);
  const close = () => { setShow(false); dot.current?.focus(); };
  useEffect(() => {
    let active = true;
    const check = (action: string) => void detect(action).catch(e => { if (active) setError(userErrorMessage(e, "配音环境检测失败")); });
    const focus = () => check("check");
    check(installing ? "status" : "check"); window.addEventListener("focus", focus);
    const timer = installing ? setInterval(() => check("status"), 1200) : undefined;
    return () => { active = false; window.removeEventListener("focus", focus); clearInterval(timer); };
  }, [installing]);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(userErrorMessage(e, "配音环境操作失败")); } finally { setBusy(false); }
  }
  useEffect(() => { if (installing) setAdvanced(false); }, [installing]);
  const previous = useRef(ready);
  useEffect(() => { if (ready && !previous.current && show) close(); previous.current = ready; }, [ready, show]);
  return <>
    <button ref={dot} type="button" className={`comfy-environment-dot${ready ? " is-ready" : ""}`} aria-label="配音环境" aria-haspopup="dialog"
      title={error || state?.message || "正在检测配音环境"} onClick={() => { setShow(true); if (!installing) void act(async () => { await detect("check"); }); }}><span aria-hidden="true" /></button>
    {show && <ModalShell title="本机配音环境" onClose={close} width="sm" className="voice-environment-dialog">
      <div onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        <p role="status">{state?.message || "正在检测…"}</p>
        {state?.gpu && <small>{state.gpu}</small>}
        {installing && <progress aria-label="安装进度" value={state.completed_bytes} max={state.total_bytes || 1} />}
        <div className="voice-card-actions">
          <button disabled={busy || installing} title={state?.directory} onClick={() => void act(async () => {
            const path = await open({ directory: true, multiple: false });
            if (typeof path === "string") publish(await voiceApi.environment("check", path));
          })}>安装位置</button>
          <button disabled={busy || (!installing && !state?.can_install && !ready)} onClick={() => void act(async () => {
            publish(await voiceApi.environment(installing ? "pause" : ready ? "check" : "install"));
          })}>{installing ? "暂停" : ready ? "重新检测" : state?.phase === "paused" || state?.phase === "failed" ? "继续准备" : "下载并启用"}</button>
        </div>
        {!installing && <details open={advanced} onToggle={e => {
          const expanded = e.currentTarget.open; setAdvanced(expanded);
          if (expanded) void act(async () => setConfig((await voiceApi.snapshot(projectId)).config));
        }}><summary>连接已有环境</summary>{(["python", "model"] as const).map(field => <button key={field} disabled={busy} title={config[field]} onClick={() => void act(async () => {
          const path = await open({ directory: field === "model", multiple: false });
          if (typeof path === "string") setConfig(c => ({ ...c, [field]: path }));
        })}>{field === "python" ? "选择 Python" : "选择模型目录"}</button>)}
          <button disabled={busy || !config.python || !config.model} onClick={() => void act(async () => { await voiceApi.configure(config); await detect("check"); })}>连接并检查</button>
        </details>}
        {error && <p role="alert">{error}</p>}
      </div>
    </ModalShell>}
  </>;
}
