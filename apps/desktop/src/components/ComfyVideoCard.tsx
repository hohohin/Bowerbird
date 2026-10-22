import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { comfyEnvironment, comfyEnvironmentReady, DEFAULT_COMFY_VIDEO, type ComfyEnvironment, type ComfyVideoOptions } from "../lib/comfyVideo";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError } from "../lib/notify";
import type { Asset } from "../lib/types";
import type { WorkflowNode, WorkflowStep } from "../lib/canvasWorkflow";
import "./ComfyVideoCard.css";
import { ProviderQuota } from "./creation/ProviderQuota";

export function ComfyGenerationProgress({ step }: { step: WorkflowStep }) {
  const progress = step.comfyStopping ? undefined : step.comfyProgress;
  const determinate = progress?.value != null && progress.max != null && progress.max > 0;
  const percent = determinate ? Math.min(100, Math.max(0, progress.value! / progress.max! * 100)) : undefined;
  return <div className="comfy-generation-progress" role="status">
    <span>{step.comfyStopping ? "正在中断本机生成…" : progress?.label ?? step.detail ?? "等待本机进度"}</span>
    <div className="comfy-progress-bar" role="progressbar" aria-label="本地视频当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="comfy-progress-fill" style={{ width: `${percent ?? 0}%` }} />
      {percent != null && <span className="comfy-progress-percent">{Math.round(percent)}%</span>}
    </div>
  </div>;
}

export function ComfyEnvironmentControl({ node, disabled, onChange }: {
  node: WorkflowNode; disabled: boolean; onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  const dialog = useRef<HTMLDialogElement>(null);
  const dot = useRef<HTMLButtonElement>(null);
  const [environment, setEnvironment] = useState<ComfyEnvironment>();
  const [connectionError, setConnectionError] = useState("");
  const [checking, setChecking] = useState(true);
  const [directory, setDirectory] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [acting, setActing] = useState(false);
  const latest = useRef({ options, onChange, disabled }); latest.current = { options, onChange, disabled };
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
    const refreshEnvironment = () => { setChecking(true); setRefresh(value => value + 1); };
    window.addEventListener("focus", refreshEnvironment);
    return () => window.removeEventListener("focus", refreshEnvironment);
  }, []);
  const ready = comfyEnvironmentReady(environment) && !connectionError;
  const preparing = environment?.phase === "installing" || environment?.phase === "starting";
  const existing = environment?.existing ?? [];
  const canPrepare = existing.length ? existing[0].canStart : environment?.installed && environment.canInstall;
  const recheck = !!connectionError || environment?.phase === "unavailable";
  const failed = environment?.phase === "failed";
  const actionLabel = preparing || acting
    ? environment?.phase === "starting" || canPrepare ? "启动中…" : "安装中…"
    : checking ? "检测中…" : recheck ? "重新检测" : ready ? "已就绪"
    : canPrepare ? failed ? "重试启动" : "启动"
    : existing.length || environment?.installed ? "无法启动"
    : !environment?.canInstall ? "暂不可安装"
    : failed ? "重试安装" : environment.phase === "cancelled" ? "继续安装" : "安装";
  const actionDisabled = disabled || checking || acting || preparing || ready || (!recheck && !canPrepare && !environment?.canInstall);
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
  const message = connectionError || (checking ? "正在检查本机环境…" : ready && environment?.phase !== "ready" && environment?.phase !== "starting"
    ? "环境已就绪，运行卡片时会自动启动" : environment?.message || "环境未就绪");
  async function install() {
    if (actionDisabled) return;
    if (recheck) { setChecking(true); setRefresh(value => value + 1); return; }
    const token = ++request.current; setChecking(false); setActing(true); setConnectionError("");
    try {
      const state = await comfyEnvironment(canPrepare ? "prepare" : "install", options.endpoint, directory);
      if (mounted.current && request.current === token) accept(state);
    } catch (error) { if (mounted.current && request.current === token) setConnectionError(String(error)); }
    finally { if (mounted.current) setActing(false); }
  }
  return <>
    <button ref={dot} type="button" className={`comfy-environment-dot${ready ? " is-ready" : ""}`}
      aria-label={ready ? "本地部署工作流：环境就绪" : "本地部署工作流：环境未就绪，打开环境设置"}
      aria-haspopup="dialog" title={message} onClick={() => { if (!ready) { setChecking(true); dialog.current?.showModal(); setRefresh(value => value + 1); } }}>
      <span aria-hidden="true" />
    </button>
    {createPortal(<dialog ref={dialog} className="comfy-environment-panel" aria-label="本地部署工作流环境设置"
      onClose={() => dot.current?.focus()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
      } }}>
      <h2>本地部署工作流</h2>
      <p role="status">{message}</p>
      <p className="comfy-install-path">{environment?.directory || directory || "正在读取安装位置…"}</p>
      {environment && !ready && !existing.length && !environment.installed && !preparing && <small>下载 {gb(environment.downloadBytes)} · 需空闲 {gb(environment.requiredBytes)}</small>}
      {environment?.phase === "installing" && <>
        <progress aria-label="环境下载进度" max={environment.totalBytes || 1} value={environment.completedBytes} />
        <small>{gb(environment.completedBytes)} / {gb(environment.totalBytes)} · 关闭面板后继续安装</small>
      </>}
      <div className="comfy-environment-actions">
        <button type="button" disabled={disabled || checking || acting || preparing || ready} onClick={async () => {
          try { const selected = await open({ directory: true, multiple: false, title: "选择本地部署工作流的安装位置" }); if (typeof selected === "string" && selected !== directory) { setChecking(true); setDirectory(selected); } }
          catch (error) { setConnectionError(String(error)); }
        }}>安装位置</button>
        <button type="button" disabled={actionDisabled} onClick={() => void install()}>{actionLabel}</button>
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
      <label>时长（秒）<input aria-label="H3 时长" type="number" min={1} max={15} step={1} value={options.seconds} onChange={event => update({ seconds: Number(event.target.value) })} /></label>
      <label>比例<select aria-label="H3 比例" value={options.ratio} onChange={event => update({ ratio: event.target.value as ComfyVideoOptions["ratio"] })}>
        {["9:16", "16:9", "4:3"].map(ratio => <option key={ratio}>{ratio}</option>)}
      </select></label>
      <label>分辨率<select aria-label="H3 分辨率" value={options.resolution} onChange={event => update({ resolution: Number(event.target.value) as ComfyVideoOptions["resolution"] })}>
        {[0.6, 0.8, 1].map(value => <option value={value} key={value}>{value.toFixed(1)}</option>)}
      </select></label>
    </fieldset>
    <ProviderQuota source="local" badge />
  </section>;
}
