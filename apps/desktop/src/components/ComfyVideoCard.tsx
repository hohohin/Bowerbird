import { userErrorMessage } from "../lib/userError";
import { useEffect, useId, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { comfyEnvironment, comfyEnvironmentReady, DEFAULT_COMFY_VIDEO, type ComfyEnvironment, type ComfyVideoOptions } from "../lib/comfyVideo";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError } from "../lib/notify";
import type { Asset } from "../lib/types";
import type { WorkflowNode, WorkflowStep } from "../lib/canvasWorkflow";
import "./ComfyVideoCard.css";
import { ProviderQuota } from "./creation/ProviderQuota";
import { TacticalSelect } from "./TacticalSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { RATIOS } from "./creation/ratios";
import h3License from "../assets/comfy-licenses/MiniMax-H3-LICENSE.txt?raw";

const H3_RATIOS = RATIOS.filter(ratio => ["9:16", "16:9", "4:3", "3:4", "1:1"].includes(ratio.key));

function EnvironmentAction({ label, disabled, hint, onClick }: {
  label: string; disabled: boolean; hint: string; onClick: () => void;
}) {
  const hintId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const showHint = (hovered || focused) && !dismissed;
  return <span className="comfy-environment-action" tabIndex={disabled ? 0 : undefined}
    role={disabled ? "group" : undefined} aria-label={disabled ? label : undefined} aria-describedby={disabled ? hintId : undefined}
    onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)}
    onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}
    onKeyDown={event => { if (event.key === "Escape" && showHint) { event.preventDefault(); event.stopPropagation(); setDismissed(true); } }}>
    <button type="button" disabled={disabled} aria-describedby={hintId} onClick={onClick}>{label}</button>
    <span id={hintId} role="tooltip" className="comfy-environment-tooltip" hidden={!showHint}>{hint}</span>
  </span>;
}

export function ComfyGenerationProgress({ step }: { step: WorkflowStep }) {
  const progress = step.comfyStopping ? undefined : step.comfyProgress;
  const determinate = progress?.value != null && progress.max != null && progress.max > 0;
  const percent = determinate ? Math.min(100, Math.max(0, progress.value! / progress.max! * 100)) : undefined;
  return <div className="comfy-generation-progress" role="status">
    <span>{step.comfyStopping ? "正在中断本机生成…" : userErrorMessage(progress?.label ?? step.detail, "等待本机进度")}</span>
    <div className="comfy-progress-bar" role="progressbar" aria-label="本地视频当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="comfy-progress-fill" style={{ width: `${percent ?? 0}%` }} />
      {percent != null && <span className="comfy-progress-percent">{Math.round(percent)}%</span>}
    </div>
  </div>;
}

export interface ComfyEnvironmentState { ready: boolean; checking: boolean; message: string }
export function ComfyEnvironmentControl({ node, disabled, onChange, composer = false, onStatusChange }: {
  node: Pick<WorkflowNode, "comfyVideo">; disabled: boolean; onChange: (patch: Partial<WorkflowNode>) => void;
  composer?: boolean; onStatusChange?: (state: ComfyEnvironmentState) => void;
}) {
  const panelId = useId();
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  const dialog = useRef<HTMLDialogElement>(null);
  const dot = useRef<HTMLButtonElement>(null);
  const [environment, setEnvironment] = useState<ComfyEnvironment>();
  const [connectionError, setConnectionError] = useState("");
  const [checking, setChecking] = useState(true);
  const [directory, setDirectory] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [acting, setActing] = useState(false);
  const [driverOpening, setDriverOpening] = useState(false);
  const actionInFlight = useRef(false);
  const latest = useRef({ options, onChange, disabled, environment }); latest.current = { options, onChange, disabled, environment };
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  function accept(state: ComfyEnvironment) {
    setEnvironment(state); setConnectionError("");
    if (comfyEnvironmentReady(state)) dialog.current?.close();
    if (state.phase === "ready" && state.endpoint !== latest.current.options.endpoint && !latest.current.disabled) {
      latest.current.onChange({ comfyVideo: { ...latest.current.options, endpoint: state.endpoint } });
    }
  }
  useEffect(() => {
    if (actionInFlight.current) return;
    const token = ++request.current;
    setChecking(true);
    const timer = window.setTimeout(() => {
      comfyEnvironment("detect", options.endpoint, directory).then(state => {
        if (mounted.current && request.current === token) accept(state);
      }).catch(error => { if (mounted.current && request.current === token) setConnectionError(String(error)); })
        .finally(() => { if (mounted.current && request.current === token) setChecking(false); });
    }, 250);
    return () => { window.clearTimeout(timer); request.current++; };
  }, [options.endpoint, directory, refresh, disabled]);
  useEffect(() => {
    if (environment?.phase !== "installing" && environment?.phase !== "starting") return;
    let stopped = false;
    let timer: number;
    async function poll() {
      try { const state = await comfyEnvironment("status", latest.current.options.endpoint); if (!stopped) accept(state); }
      catch (error) { if (!stopped) setConnectionError(String(error)); }
      if (!stopped) timer = window.setTimeout(poll, 1000);
    }
    timer = window.setTimeout(poll, 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [environment?.phase]);
  useEffect(() => {
    let timer: number | undefined;
    const refreshEnvironment = () => {
      window.clearTimeout(timer);
      const token = request.current;
      // Focusing the app can be the pointer-down of the Install click itself.
      // Let that click finish before deciding whether an idle refresh is needed.
      timer = window.setTimeout(() => {
        if (token !== request.current || actionInFlight.current || ["installing", "starting"].includes(latest.current.environment?.phase ?? "")) return;
        setChecking(true); setRefresh(value => value + 1);
      }, 250);
    };
    window.addEventListener("focus", refreshEnvironment);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", refreshEnvironment); };
  }, []);
  const ready = comfyEnvironmentReady(environment) && !connectionError;
  const preparing = environment?.phase === "installing" || environment?.phase === "starting";
  const existing = environment?.existing ?? [];
  const canPrepare = existing.length ? existing[0].canStart : environment?.installed && environment.canInstall;
  const recheck = !!connectionError || environment?.phase === "unavailable";
  const failed = environment?.phase === "failed";
  const needsDriver = environment?.hardware?.driverRequired === true && !ready && !canPrepare;
  const actionLabel = driverOpening ? "正在匹配驱动…" : preparing || acting
    ? environment?.phase === "starting" || canPrepare ? "启动中…" : "安装中…"
    : checking ? "检测中…" : recheck ? "重新检测" : ready ? "已就绪" : needsDriver ? "下载显卡驱动"
    : canPrepare ? failed ? "重试启动" : "启动"
    : existing.length || environment?.installed ? "无法启动"
    : !environment?.canInstall ? "暂不可安装"
    : failed ? "重试安装" : environment.phase === "cancelled" ? "继续安装" : "安装";
  const actionDisabled = disabled || checking || acting || preparing || ready || (!recheck && !needsDriver && !canPrepare && !environment?.canInstall);
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
  const message = connectionError ? userErrorMessage(connectionError, "暂时无法检查本地生成环境，请重新检测。") : (checking ? "正在检查本机环境…" : ready && environment?.phase !== "ready" && environment?.phase !== "starting"
    ? "环境已就绪，运行卡片时会自动启动" : userErrorMessage(environment?.message, "环境未就绪，请重新检测或检查安装位置。"));
  const busyHint = disabled ? "当前视频任务正在执行，请等待任务结束或停止任务后再调整环境。"
    : driverOpening ? "正在匹配官方显卡驱动，请稍候，勿重复点击。"
    : checking ? "正在检测本机环境，请稍候；检测完成后会自动更新可用操作。"
    : preparing || acting ? `${message}。请等待当前操作完成，无需重复操作；安装期间关闭面板仍会继续。`
    : ready ? "环境已就绪，无需再次安装；接好输入后直接运行视频卡片。" : "";
  const actionHint = busyHint || (recheck ? `${message}。处理后点击重新检测。`
    : needsDriver ? `${message}。点击匹配并下载 NVIDIA 官方驱动，安装后返回应用自动复查。`
    : !canPrepare && !environment?.canInstall ? message
    : canPrepare ? `${message}。点击启动已有环境并检查模型，无需重新下载。`
    : `${failed ? `${message}。` : ""}点击下载并安装所需环境，已下载的资源会校验后继续使用。`);
  useEffect(() => { onStatusChange?.({ ready: ready && !checking && !acting, checking, message }); }, [ready, checking, acting, message, onStatusChange]);
  async function install() {
    if (actionDisabled || actionInFlight.current) return;
    if (recheck) { setChecking(true); setRefresh(value => value + 1); return; }
    actionInFlight.current = true;
    request.current++; setChecking(false); setActing(true); setConnectionError("");
    try {
      if (needsDriver) setDriverOpening(true);
      const state = await comfyEnvironment(needsDriver ? "driver" : canPrepare ? "prepare" : "install", options.endpoint, directory);
      if (mounted.current) {
        accept(state);
        if (needsDriver && state.driverDownload) await openExternal(state.driverDownload.url);
      }
    } catch (error) {
      if (mounted.current) setEnvironment(previous => previous ? { ...previous, phase: "failed", message: String(error) } : previous);
    } finally {
      actionInFlight.current = false;
      if (mounted.current) { setChecking(false); setActing(false); setDriverOpening(false); }
    }
  }
  return <>
    <button ref={dot} type="button" className={`comfy-environment-dot${ready ? " is-ready" : ""}${composer ? " composer-environment" : ""}`}
      aria-label={ready ? "本地部署工作流：环境就绪" : "本地部署工作流：环境未就绪，打开环境设置"}
      aria-haspopup="dialog" aria-controls={panelId} title={message} onClick={() => { if (!ready) {
        dialog.current?.showModal();
        if (!actionInFlight.current && !preparing) { setChecking(true); setRefresh(value => value + 1); }
      } }}>
      {composer && (!ready || checking) ? <><CircleAlert size={13} aria-hidden="true" /><span className="environment-full">{checking ? "正在检测环境…" : "环境未就绪，点击配置"}</span><span className="environment-short">{checking ? "检测中…" : "配置环境"}</span></> : <span aria-hidden="true" />}
    </button>
    {createPortal(<dialog ref={dialog} id={panelId} className="comfy-environment-panel" aria-label="本地部署工作流环境设置"
      onClose={() => dot.current?.focus()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
      } }}>
      <h2>本地部署工作流</h2>
      <p role="status">{message}</p>
      {environment?.hardware?.gpus.map((gpu, index) => <p key={index} className="comfy-install-path">{gpu.name}
        {gpu.memoryMib != null && ` · 显存 ${(gpu.memoryMib / 1024).toFixed(1)} GB`}
        {` · 驱动 ${gpu.driver ?? "未识别"}`}</p>)}
      <p className="comfy-install-path">{environment?.directory || directory || "正在读取安装位置…"}</p>
      <details><summary>MiniMax H3 使用许可</summary><p>点击安装即同意以下许可（含适用地区及用途限制）。许可与来源文件将保存在安装目录的 licenses 文件夹。</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 180, overflow: "auto" }}>{h3License}</pre></details>
      {environment && !ready && !existing.length && !environment.installed && !preparing && <small>下载 {gb(environment.downloadBytes)} · 需空闲 {gb(environment.requiredBytes)}</small>}
      {environment?.phase === "installing" && <>
        <progress aria-label="环境下载进度" max={environment.totalBytes || 1} value={environment.completedBytes} />
        <small>{gb(environment.completedBytes)} / {gb(environment.totalBytes)} · 关闭面板后继续安装</small>
      </>}
      <div className="comfy-environment-actions">
        <EnvironmentAction label="安装位置" disabled={disabled || checking || acting || preparing || ready}
          hint={busyHint || "选择安装位置，应用会在所选文件夹下创建 Bowerbird-ComfyUI；选好后自动重新检查磁盘空间。"} onClick={async () => {
          try { const selected = await open({ directory: true, multiple: false, title: "选择本地部署工作流的安装位置" }); if (typeof selected === "string" && selected !== directory) { setChecking(true); setDirectory(selected); } }
          catch (error) { setConnectionError(String(error)); }
        }} />
        <EnvironmentAction label={actionLabel} disabled={actionDisabled} hint={actionHint} onClick={() => void install()} />
      </div>
    </dialog>, document.body)}
  </>;
}

export function ComfyVideoCard({ node, disabled, assets, inputImages, onChange }: {
  node: WorkflowNode; disabled: boolean; assets: Asset[];
  inputImages: (input: import("../lib/canvasWorkflow").WorkflowInput) => string[];
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  function update(patch: Partial<ComfyVideoOptions>) { onChange({ comfyVideo: { ...options, ...patch } }); }
  return <section className="comfy-video-card" aria-label="本地 H3 视频设置">
    <div className="comfy-frame-slots">{(["first-frame", "last-frame"] as const).map((port, index) => {
      const bindings = node.inputs[port] ?? [];
      const ids = bindings.flatMap(inputImages);
      const asset = assets.find(asset => asset.id === ids[0]);
      const path = asset?.thumb_path ?? asset?.store_path;
      return <div key={port} className="comfy-frame-slot" aria-label={index ? "尾帧输入" : "首帧输入"}
        onDragOver={event => { if (getDragAssets()) { event.preventDefault(); event.stopPropagation(); } }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation(); if (disabled) return;
          const ids = getDragAssets();
          if (ids?.length !== 1) { notifyError(null, "每个帧输入只接收一张图片"); return; }
          onChange({ inputs: { ...node.inputs, [port]: [{ assetId: ids[0] }] } });
        }}>
        <strong className="comfy-frame-badge">{index ? "尾帧 · 可选" : "首帧"}</strong>
        {path ? <img alt={index ? "尾帧" : "首帧"} src={path.startsWith("data:") ? path : convertFileSrc(path)} draggable={false} />
          : <span>{bindings.length ? "已连接 · 等待上游" : "拖入图片或连接端口"}</span>}
      </div>;
    })}</div>
    <textarea className="comfy-video-prompt" aria-label="卡片指令" disabled={disabled}
      placeholder="输入视频提示词，也可从文本端口接入…" value={node.prompt}
      onChange={event => onChange({ prompt: event.target.value })} />
    <fieldset disabled={disabled} className="comfy-video-options">
      <label>时长<input aria-label="H3 时长" type="number" min={1} max={15} step={1} value={options.seconds} onChange={event => update({ seconds: Number(event.target.value) })} />秒</label>
      <RatioSelect ariaLabel="H3 比例" value={options.ratio === "auto" ? null : options.ratio} ratios={H3_RATIOS}
        autoTitle="按运行时首帧图片的实际宽高比生成，尺寸按模型要求对齐"
        onChange={ratio => update({ ratio: (ratio ?? "auto") as ComfyVideoOptions["ratio"] })} />
      <TacticalSelect aria-label="H3 分辨率" title="分辨率（MP）" value={options.resolution} onValueChange={value => update({ resolution: Number(value) as ComfyVideoOptions["resolution"] })}>
        {[0.6, 0.8, 1].map(value => <option value={value} key={value}>{value.toFixed(1)}</option>)}
      </TacticalSelect>
    </fieldset>
    <ProviderQuota source="local" badge />
  </section>;
}
