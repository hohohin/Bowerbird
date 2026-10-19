import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { comfyEnvironment, comfyVideoSize, DEFAULT_COMFY_VIDEO, type ComfyEnvironment, type ComfyVideoOptions } from "../lib/comfyVideo";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError } from "../lib/notify";
import type { Asset } from "../lib/types";
import type { WorkflowNode } from "../lib/canvasWorkflow";
import "./ComfyVideoCard.css";

export function ComfyVideoCard({ node, disabled, assets, inputImages, onChange }: {
  node: WorkflowNode; disabled: boolean; assets: Asset[];
  inputImages: (input: import("../lib/canvasWorkflow").WorkflowInput) => string[];
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  const size = comfyVideoSize(options);
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
  }, [options.endpoint, directory, refresh]);
  useEffect(() => {
    if (environment?.phase !== "installing") return;
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
  async function setup(action: "install" | "cancel") {
    const token = ++request.current; setChecking(false); setActing(true); setConnectionError("");
    try { const state = await comfyEnvironment(action, options.endpoint, directory); if (mounted.current && request.current === token) accept(state); }
    catch (error) { if (mounted.current && request.current === token) setConnectionError(String(error)); }
    finally { if (mounted.current) setActing(false); }
  }
  const installing = environment?.phase === "installing";
  const ready = environment?.phase === "ready" && !connectionError;
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
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
        <strong>{index ? "尾帧 · 可选" : "首帧"}</strong>
        {path ? <img alt={index ? "尾帧" : "首帧"} src={path.startsWith("data:") ? path : convertFileSrc(path)} draggable={false} />
          : <span>{bindings.length ? "已连接 · 等待上游" : "拖入图片或连接端口"}</span>}
        {!!bindings.length && <button type="button" disabled={disabled} aria-label={index ? "移除尾帧" : "移除首帧"} onClick={() => onChange({ inputs: { ...node.inputs, [port]: [] } })}>移除</button>}
      </div>;
    })}</div>
    <fieldset disabled={disabled} className="comfy-video-options">
      <label>时长（秒）<input aria-label="H3 时长" type="number" min={1} max={15} step={1} value={options.seconds} onChange={event => update({ seconds: Number(event.target.value) })} /></label>
      <label>比例<select aria-label="H3 比例" value={options.ratio} onChange={event => update({ ratio: event.target.value as ComfyVideoOptions["ratio"] })}>
        {["9:16", "16:9", "4:3"].map(ratio => <option key={ratio}>{ratio}</option>)}
      </select></label>
      <label>分辨率<select aria-label="H3 分辨率" value={options.resolution} onChange={event => update({ resolution: Number(event.target.value) as ComfyVideoOptions["resolution"] })}>
        {[0.6, 0.8, 1].map(value => <option value={value} key={value}>{value.toFixed(1)}</option>)}
      </select></label>
    </fieldset>
    <p className="workflow-hint">{size.width} × {size.height} · 24 fps · 约 {(size.frames / 24).toFixed(2)} 秒 · 1 个视频</p>
    <div className={`comfy-environment${ready ? " is-ready" : ""}`} aria-label="本机运行环境">
      <div className="comfy-environment-heading"><strong>{checking ? "正在检查本机环境…" : ready ? "本机环境已就绪" : installing ? "正在准备本机环境" : "需要准备本机环境"}</strong>
        <button type="button" disabled={checking || acting || installing} onClick={() => setRefresh(value => value + 1)}>重新检测</button></div>
      <p role="status">{connectionError || (checking ? "自动查找 ComfyUI，并检查所需模型与节点" : environment?.message)}</p>
      {environment && !ready && !checking && <>
        {installing ? <>
          <progress aria-label="环境下载进度" max={environment.totalBytes || 1} value={environment.completedBytes} />
          <small>{gb(environment.completedBytes)} / {gb(environment.totalBytes)} · 关闭卡片后仍会继续</small>
          <button type="button" disabled={acting} onClick={() => void setup("cancel")}>取消准备</button>
        </> : <>
          <small>{environment.installed ? "已安装，可直接启动" : `将下载 ComfyUI、Python 和 5 个模型 · 剩余 ${gb(environment.downloadBytes)} · 需空闲 ${gb(environment.requiredBytes)}`}</small>
          <div className="comfy-install-path" title={environment.directory}>{environment.directory}</div>
          <div className="comfy-environment-actions">
            <button type="button" disabled={disabled || acting || !environment.canInstall} onClick={() => void setup("install")}>{acting ? "准备中…" : environment.installed ? "一键启动" : environment.phase === "failed" || environment.phase === "cancelled" ? "继续安装" : "一键下载并安装"}</button>
            <button type="button" disabled={disabled || acting} onClick={async () => {
              try { const selected = await open({ directory: true, multiple: false, title: "选择安装位置（将新建 Bowerbird-ComfyUI 文件夹）" }); if (typeof selected === "string") setDirectory(selected); }
              catch (error) { setConnectionError(String(error)); }
            }}>更换位置</button>
          </div>
          <small>独立安装到所选位置，完成后自动启动并检查。需保持 Bowerbird 开启。</small>
        </>}
      </>}
      <details><summary>高级连接设置</summary>
        <label>ComfyUI 地址<input aria-label="ComfyUI 地址" disabled={disabled || installing || acting} value={options.endpoint} onChange={event => update({ endpoint: event.target.value })} /></label>
        <small>支持已有本机服务；自动检查和安装均不会提交视频生成。</small>
      </details>
    </div>
  </section>;
}
