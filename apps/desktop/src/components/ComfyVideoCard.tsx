
import { CanvasTextarea } from "./CanvasTextarea";
import { userErrorMessage } from "../lib/userError";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeftRight, AudioLines, Check, CircleAlert, Ellipsis, Film, Gauge, Images, Timer, X } from "lucide-react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { comfyAudioHint, comfyAudioLabel, comfyEnvironmentReady, comfyVideoMode, comfyVideoOptionsForMode, DEFAULT_COMFY_VIDEO, H3_IMAGE_ENDPOINT, H3_R2V_LIMITS, H3_R2V_REFERENCE_HINT, H3_VIDEO_MODES, H3_VIDEO_RESOLUTIONS, type ComfyVideoOptions, type ComfyVideoMode, type ComfyVideoProgress } from "../lib/comfyVideo";
import { isAudioAsset } from "../lib/audioMedia";
import { api } from "../lib/api";
import { useComfyEnvironment } from "../lib/comfyEnvironmentState";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError } from "../lib/notify";
import type { Asset } from "../lib/types";
import { H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT, workflowBindingKey, workflowFrameLabel, workflowVideoAudioLabel, type WorkflowInput, type WorkflowNode } from "../lib/canvasWorkflow";
import { workflowAssetMedia } from "../lib/workflowCanvasCapabilities";
import { isVideoAsset, isVideoPath } from "../lib/videoGeneration";
import "./ComfyVideoCard.css";
import { TacticalSelect } from "./TacticalSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { RATIOS } from "./creation/ratios";
import imageLicense from "../assets/comfy-licenses/MiniMax-H3-Image-LICENSE.txt?raw";
import h3License from "../assets/comfy-licenses/MiniMax-H3-LICENSE.txt?raw";

const H3_RATIOS = RATIOS.filter(ratio => ["9:16", "16:9", "4:3", "3:4", "1:1"].includes(ratio.key));
const R2V_GROUPS = [
  { media: "image", label: "参考图片", Icon: Images, tag: "Picture" },
  { media: "video", label: "参考视频", Icon: Film, tag: "Video" },
  { media: "audio", label: "参考音频", Icon: AudioLines, tag: "Audio" },
] as const;

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

export function ComfyGenerationProgress({ progress }: { progress: ComfyVideoProgress }) {
  const { value, max } = progress;
  const percent = value != null && max != null && max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : undefined;
  return <span className="comfy-progress-bar" role="progressbar" aria-label="本地视频当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <span className="comfy-progress-fill" style={{ width: `${percent ?? 0}%` }} />
    {percent != null && <span className="comfy-progress-percent" aria-hidden="true">{Math.round(percent)}%</span>}
  </span>;
}

export interface ComfyEnvironmentState { ready: boolean; checking: boolean; message: string }
export function ComfyEnvironmentControl({ node, disabled, onChange, imageMode, composer = false, onStatusChange }: {
  node: Pick<WorkflowNode, "comfyVideo">; disabled: boolean; onChange: (patch: Partial<WorkflowNode>) => void;
  imageMode?: "image" | "edit"; composer?: boolean; onStatusChange?: (state: ComfyEnvironmentState) => void;
}) {
  const panelId = useId();
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  const mode = imageMode ?? comfyVideoMode(options);
  const endpoint = imageMode ? H3_IMAGE_ENDPOINT : options.endpoint;
  const dialog = useRef<HTMLDialogElement>(null);
  const dot = useRef<HTMLButtonElement>(null);
  const [directory, setDirectory] = useState<string>();
  const [driverOpening, setDriverOpening] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const { environment, error, checking, acting, check } = useComfyEnvironment(mode, endpoint, directory);
  const connectionError = pickerError || error;
  useEffect(() => {
    if (connectionError || !environment || (environment.mode && environment.mode !== mode)) return;
    if (comfyEnvironmentReady(environment)) dialog.current?.close();
    if (!imageMode && environment.phase === "ready" && environment.endpoint !== options.endpoint && !disabled) {
      onChange({ comfyVideo: { ...options, endpoint: environment.endpoint } });
    }
  }, [connectionError, environment, mode, imageMode, options, disabled, onChange]);
  const ready = comfyEnvironmentReady(environment) && (!environment?.mode || environment.mode === mode) && !connectionError;
  const preparing = environment?.phase === "installing" || environment?.phase === "starting";
  const existing = environment?.existing ?? [];
  const canPrepare = existing.length ? existing[0].canStart : environment?.installed && environment.canInstall;
  const recheck = !!connectionError || environment?.phase === "unavailable" && !environment.canAddModels;
  const failed = environment?.phase === "failed";
  const needsDriver = environment?.hardware?.driverRequired === true && !ready && !canPrepare;
  const actionLabel = driverOpening ? "正在匹配驱动…" : preparing || acting
    ? environment?.phase === "starting" || canPrepare ? "启动中…" : "安装中…"
    : checking ? "检测中…" : recheck ? "重新检测" : ready ? "已就绪" : needsDriver ? "下载显卡驱动"
    : environment?.canAddModels ? "下载模型"
    : canPrepare ? failed ? "重试启动" : "启动"
    : existing.length || environment?.installed ? "无法启动"
    : !environment?.canInstall ? "暂不可安装"
    : failed ? "重试安装" : environment.phase === "cancelled" ? "继续安装" : "安装";
  const actionDisabled = disabled || checking || acting || preparing || ready || (!recheck && !needsDriver && !canPrepare && !environment?.canInstall);
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
  const message = connectionError ? userErrorMessage(connectionError, "暂时无法检查本地生成环境，请重新检测。") : (checking ? "正在检查本机环境…" : ready && environment?.phase !== "ready" && environment?.phase !== "starting" && environment?.phase !== "recoverable"
    ? "环境已就绪，运行卡片时会自动启动" : userErrorMessage(environment?.message, "环境未就绪，请重新检测或检查安装位置。"));
  const busyHint = disabled ? "当前生成任务正在执行，请等待任务结束或停止任务后再调整环境。"
    : driverOpening ? "正在匹配官方显卡驱动，请稍候，勿重复点击。"
    : checking ? "正在检测本机环境，请稍候；检测完成后会自动更新可用操作。"
    : preparing || acting ? `${message}。请等待当前操作完成，无需重复操作；安装期间关闭面板仍会继续。`
    : ready ? "环境已就绪，无需再次安装；可以直接开始生成。" : "";
  const actionHint = busyHint || (recheck ? `${message}。处理后点击重新检测。`
    : needsDriver ? `${message}。点击匹配并下载 NVIDIA 官方驱动，安装后返回应用自动复查。`
    : !canPrepare && !environment?.canInstall ? message
    : canPrepare ? `${message}。点击启动已有环境并检查模型，无需重新下载。`
    : `${failed ? `${message}。` : ""}点击下载并安装所需环境，已下载的资源会校验后继续使用。`);
  useEffect(() => { onStatusChange?.({ ready: ready && !checking && !acting, checking, message }); }, [ready, checking, acting, message, onStatusChange]);
  async function selectExisting() {
    setPickerError("");
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择已有 ComfyUI" });
      if (typeof selected !== "string") return;
      await check.run("select_existing", selected);
      setDirectory(undefined);
    } catch (error) {
      setPickerError(String(error));
    }
  }
  async function install() {
    if (actionDisabled) return;
    setPickerError("");
    if (recheck) { void check.refresh(true); return; }
    if (needsDriver) setDriverOpening(true);
    try {
      await check.run(needsDriver ? "driver" : environment?.canAddModels ? "install" : canPrepare ? "prepare" : "install", undefined, openExternal);
    } finally {
      setDriverOpening(false);
    }
  }
  return <>
    <button ref={dot} type="button" className={`comfy-environment-dot${imageMode ? " h3-image-environment" : ""}${ready ? " is-ready" : ""}${composer ? " composer-environment" : ""}`}
      aria-label={imageMode && checking ? "本地部署工作流：正在检测环境" : ready ? "本地部署工作流：环境就绪" : "本地部署工作流：环境未就绪，打开环境设置"}
      aria-haspopup="dialog" aria-controls={panelId} title={message} onClick={() => { if (!ready) {
        dialog.current?.showModal();
        if (!acting && !preparing) { setPickerError(""); void check.refresh(); }
      } }}>
      {imageMode ? (checking ? <Ellipsis size={14} aria-hidden="true" /> : ready ? <Check size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />) : composer && (!ready || checking) ? <><CircleAlert size={13} aria-hidden="true" /><span className="environment-full">{checking ? "正在检测环境…" : "环境未就绪，点击配置"}</span><span className="environment-short">{checking ? "检测中…" : "配置环境"}</span></> : <span aria-hidden="true" />}
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
      <p className="comfy-install-path">{(!environment?.installed && !preparing && existing[0]?.path) || environment?.directory || directory || "正在读取安装位置…"}</p>
      <details><summary>MiniMax H3 使用许可</summary><p>点击安装即同意以下许可（含适用地区及用途限制）。许可与来源文件将保存在安装目录的 licenses 文件夹。</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 180, overflow: "auto" }}>{imageMode ? imageLicense : h3License}</pre></details>
      {environment && !ready && !existing.length && !environment.installed && !preparing && <small>下载 {gb(environment.downloadBytes)} · 需空闲 {gb(environment.requiredBytes)}</small>}
      {environment?.phase === "installing" && <>
        <progress aria-label="环境下载进度" max={environment.downloadBytes || 1} value={environment.completedBytes} />
        <small>{gb(environment.completedBytes)} / {gb(environment.downloadBytes)} · 关闭面板后继续安装</small>
      </>}
      <div className="comfy-environment-actions">
        <EnvironmentAction label="选择已有 ComfyUI" disabled={disabled || checking || acting || preparing}
          hint={busyHint || "保存已有 ComfyUI 的位置，供下次检测和启动使用。"} onClick={() => void selectExisting()} />
        <EnvironmentAction label="安装位置" disabled={disabled || checking || acting || preparing || ready}
          hint={busyHint || "选择安装位置后，应用会创建独立目录并检查磁盘空间。"} onClick={async () => {
          try { const selected = await open({ directory: true, multiple: false, title: "选择本地部署工作流的安装位置" }); if (typeof selected === "string") { setPickerError(""); setDirectory(selected); } }
          catch (error) { setPickerError(String(error)); }
        }} />
        <EnvironmentAction label={actionLabel} disabled={actionDisabled} hint={actionHint} onClick={() => void install()} />
      </div>
    </dialog>, document.body)}
  </>;
}

export function ComfyVideoCard({ node, prompt, onPromptChange, modelControl, disabled, assetById, inputImages, referencePending, videoAudioSourceName, readCurrentPrompt, onChange, optimizationActions }: {
  prompt: string; onPromptChange: (prompt: string) => void;
  optimizationActions?: React.ReactNode; modelControl: React.ReactNode; node: WorkflowNode; disabled: boolean; assetById: ReadonlyMap<string, Asset>;
  inputImages: (input: WorkflowInput, media?: keyof typeof H3_R2V_INPUT_PORTS) => string[];
  referencePending: (input: WorkflowInput) => boolean;
  videoAudioSourceName: (input: WorkflowInput) => string;
  onChange: (patch: Partial<WorkflowNode>) => void;
  readCurrentPrompt: () => string;
}) {
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  const mode = comfyVideoMode(options);
  const audioLabel = comfyAudioLabel(mode);
  const ports = mode === "frames" ? ["first-frame", "last-frame"] : mode === "reference" ? ["first-frame"] : [];
  const audioBindings = node.inputs[H3_VIDEO_AUDIO_PORT] ?? [];
  const audioIds = audioBindings.flatMap(input => inputImages(input));
  const audio = audioIds.map(id => assetById.get(id)).find(asset => asset && isAudioAsset(asset));
  const latestCard = useRef({ node, disabled, onChange });
  const audioDrop = useRef(0);
  latestCard.current = { node, disabled, onChange };
  useEffect(() => () => { audioDrop.current++; }, []);

  async function bindAudio(ids: string[] | null) {
    const drop = ++audioDrop.current;
    if (ids?.length !== 1) { notifyError(null, "请拖入一段音频"); return; }
    const previous = node.inputs[H3_VIDEO_AUDIO_PORT];
    const current = () => drop === audioDrop.current && !latestCard.current.disabled && comfyVideoMode(latestCard.current.node.comfyVideo) !== "r2v"
      && latestCard.current.node.inputs[H3_VIDEO_AUDIO_PORT] === previous;
    try {
      const asset = assetById.get(ids[0]) ?? (await api.getAssetsByIds(ids))[0];
      if (!current()) return;
      if (!asset || !isAudioAsset(asset)) { notifyError(null, "请拖入一段音频"); return; }
      latestCard.current.onChange({ inputs: { ...latestCard.current.node.inputs, [H3_VIDEO_AUDIO_PORT]: [{ assetId: asset.id }] } });
    } catch (error) {
      if (current()) notifyError(error, "无法读取参考音频");
    }
  }

  async function bindR2V(media: keyof typeof H3_R2V_INPUT_PORTS, label: string, ids: string[]) {
    const port = H3_R2V_INPUT_PORTS[media], previous = node.inputs[port];
    const limit = H3_R2V_LIMITS[media], drop = ++audioDrop.current;
    const current = () => drop === audioDrop.current && !latestCard.current.disabled && comfyVideoMode(latestCard.current.node.comfyVideo) === "r2v"
      && latestCard.current.node.inputs[port] === previous;
    const sources = (previous ?? []).map(input => ({ input, ids: inputImages(input, media) }));
    const bound = sources.flatMap(source => source.ids);
    const additions = [...new Set(ids)].filter(id => !bound.includes(id));
    if (!additions.length) return;
    const used = sources.reduce((count, { ids, input }) => count + (ids.length || Number(referencePending(input))), 0);
    if (Math.max(used, sources.length) + additions.length > limit) {
      notifyError(null, `${label}最多接入 ${limit} 个素材`); return;
    }
    try {
      const incoming = await api.getAssetsByIds(additions);
      if (!current()) return;
      if (incoming.length !== additions.length || incoming.some(asset => !asset.store_path || workflowAssetMedia(asset) !== media)) {
        notifyError(null, `请拖入可用的${label}素材`); return;
      }
      latestCard.current.onChange({ inputs: { ...latestCard.current.node.inputs,
        [port]: [...(previous ?? []), ...additions.map(assetId => ({ assetId, mediaFilter: [media] }))] } });
    } catch (error) { if (current()) notifyError(error, `无法读取${label}`); }
  }

  function update(patch: Partial<ComfyVideoOptions>) { onChange({ comfyVideo: { ...options, ...patch } }); }
  return <section className="comfy-video-card" aria-label="本地 H3 视频设置">
    <fieldset disabled={disabled} className="workflow-video-parameters comfy-video-options" aria-label="视频参数">
      {modelControl}
      <TacticalSelect aria-label="H3 模式" title="生成模式" icon={<Film size={14} />} value={mode} onValueChange={value => onChange({ comfyVideo: comfyVideoOptionsForMode(options, value as ComfyVideoMode) })}>
        {H3_VIDEO_MODES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </TacticalSelect>
      <TacticalSelect aria-label="H3 时长" title="视频时长" icon={<Timer size={14} />} value={options.seconds} onValueChange={value => update({ seconds: Number(value) })}>
        {Array.from({ length: 15 }, (_, i) => <option value={i + 1} key={i}>{i + 1} 秒</option>)}
      </TacticalSelect>
      <RatioSelect ariaLabel="H3 比例" value={options.ratio === "auto" ? null : options.ratio} ratios={H3_RATIOS}
        allowAuto={mode !== "text"} autoTitle={mode === "r2v" ? "优先沿用第一张参考图的画幅，其次是第一段参考视频。只有录音时使用 16:9" : "按运行时输入图片的实际宽高比生成，尺寸按模型要求对齐"}
        onChange={ratio => update({ ratio: (ratio ?? "auto") as ComfyVideoOptions["ratio"] })} />
      <TacticalSelect aria-label="H3 分辨率" title="生成分辨率" icon={<Gauge size={14} />} value={options.resolution === 1 ? 0.98 : options.resolution}
        onValueChange={value => update({ resolution: Number(value) as ComfyVideoOptions["resolution"] })}>
        {H3_VIDEO_RESOLUTIONS.map(({ value, label }) => <option value={value} key={value}>{label}</option>)}
      </TacticalSelect>
    </fieldset>
    {ports.length > 0 && <div className="comfy-frame-slots">{ports.map((port, index) => {
      const label = mode === "reference" ? "参考图" : index ? "尾帧" : "首帧";
      const bindings = node.inputs[port] ?? [];
      const ids = bindings.flatMap(input => inputImages(input));
      const asset = assetById.get(ids[0]);
      const { path, originalImage } = frameImagePaths(asset);
      const video = isVideoAsset(asset);
      const frameLabel = bindings[0]?.videoFrame && workflowFrameLabel(bindings[0].videoFrame);
      const framePlaceholder = video && !path && frameLabel;
      return <div key={port} className="h3-frame-group"><div className="comfy-frame-slot" aria-label={`${label}输入`}
        onDragOver={event => { if (getDragAssets()) { event.preventDefault(); event.stopPropagation(); } }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation(); if (disabled) return;
          const ids = getDragAssets();
          if (ids?.length !== 1) { notifyError(null, "每个帧输入只接收一张图片"); return; }
          onChange({ inputs: { ...node.inputs, [port]: [{ assetId: ids[0] }] } });
        }}>
        {bindings.length > 0 && <button type="button" className="comfy-frame-action comfy-frame-disconnect"
          aria-label={`断开${label}`} title={`断开${label}`} disabled={disabled}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => onChange({ inputs: { ...node.inputs, [port]: [] } })}><X size={14} /></button>}
        {path ? <ComfyFrameThumbnail label={label} path={path} previewPath={originalImage || path} />
          : <span className="comfy-frame-placeholder" title={video ? "视频暂无封面" : bindings.length ? "已连接，等待上游结果" : "拖入图片或连接端口"}>
            {framePlaceholder || (bindings.length ? "待输入" : "拖入图片")}
          </span>}
      </div><div className="h3-frame-meta"><strong>{label}</strong><small>{mode === "reference" ? "Picture 1" : `P${index + 1} · ${(index ? options.seconds : 0).toFixed(2)}s`}</small>
        {frameLabel && !framePlaceholder && <small>{frameLabel}</small>}</div></div>;
    })}
      {mode === "frames" && !!node.inputs["first-frame"]?.length && !!node.inputs["last-frame"]?.length &&
        <button type="button" className="comfy-frame-action comfy-frame-swap" aria-label="交换首尾帧" title="交换首尾帧"
          disabled={disabled} onPointerDown={event => event.stopPropagation()}
          onClick={() => onChange({ inputs: { ...node.inputs, "first-frame": node.inputs["last-frame"], "last-frame": node.inputs["first-frame"] } })}>
          <ArrowLeftRight size={14} /></button>}
    </div>}
    {mode === "r2v" && <div className="comfy-r2v-groups">
      {R2V_GROUPS.map(({ media, label, Icon, tag }) => {
        const port = H3_R2V_INPUT_PORTS[media], bindings = node.inputs[port] ?? [];
        let count = 0;
        const items = bindings.flatMap(binding => {
          const ids = inputImages(binding, media);
          const pending = !ids.length && referencePending(binding);
          return (ids.length ? ids : [undefined]).map(id => ({
            binding, id, pending, number: id || pending ? `<${tag} ${++count}>` : undefined, hasSiblings: ids.length > 1,
          }));
        });
        const showTags = media !== "audio" || !node.inputs[H3_R2V_INPUT_PORTS.video]?.some(
          input => inputImages(input, "video").length || referencePending(input));
        return <div key={port} className="comfy-audio-input" role="group" aria-label={`${label}输入`}
          onDragOver={event => { if (!disabled && getDragAssets()) { event.preventDefault(); event.stopPropagation(); } }}
          onDrop={event => {
            event.preventDefault(); event.stopPropagation();
            const ids = getDragAssets();
            if (!disabled && ids?.length) void bindR2V(media, label, ids);
          }}>
          <div className="comfy-audio-row"><Icon size={14} aria-hidden="true" /><span>{label}</span>
            <span className="comfy-audio-source">{bindings.length ? `${count} / ${H3_R2V_LIMITS[media]}` : `拖入或连接 · 最多 ${H3_R2V_LIMITS[media]} 个`}</span></div>
          {!!items.length && <div className={media === "image" ? "comfy-r2v-pictures" : "comfy-r2v-list"}>{items.map(({ binding, id, pending, number, hasSiblings }, index) => {
            const asset = id ? assetById.get(id) : undefined;
            const name = binding.videoAudio ? `${workflowVideoAudioLabel()} · ${videoAudioSourceName(binding)}` : asset?.name || (id ? "素材" : pending ? "等待上游素材" : "无匹配素材");
            const frame = binding.videoFrame && workflowFrameLabel(binding.videoFrame);
            const key = `${workflowBindingKey(binding)}:${id ?? ""}`;
            const disconnect = <button type="button" aria-label={`断开${label}来源 ${index + 1}`} title={`断开 ${name}`}
              disabled={disabled} onPointerDown={event => event.stopPropagation()} onClick={() => {
                const remaining = id && hasSiblings
                  ? bindings.map(item => item === binding ? { ...item, excludedAssetIds: [...(item.excludedAssetIds ?? []), id] } : item)
                  : bindings.filter(item => item !== binding);
                onChange({ inputs: { ...node.inputs, [port]: remaining } });
              }}><X size={14} /></button>;
            const caption = <span className="comfy-audio-source" title={name}>{frame && `${frame} · `}{name}</span>;
            if (media === "image") {
              const { path, originalImage } = frameImagePaths(asset);
              return <div key={key} className="comfy-r2v-picture" title={name}>
                <div className="comfy-r2v-picture-frame">
                  {path ? <ComfyFrameThumbnail label={name} path={path} previewPath={originalImage || path} />
                    : <span className="comfy-frame-placeholder">{pending ? "待输入" : frame || "暂无预览"}</span>}
                  {number && <small className="comfy-picture-tag">{number}</small>}{disconnect}
                </div>{caption}
              </div>;
            }
            const cover = media === "video" && imageCover(asset);
            return <div className="comfy-audio-row comfy-r2v-source" key={key}>
              {media === "video" && <span className="comfy-r2v-video-cover" aria-hidden="true">
                {cover ? <img alt="" src={comfyImageSrc(cover)} draggable={false} /> : <Film size={14} />}
              </span>}
              {showTags && number && <small>{number}</small>}{caption}{disconnect}
            </div>;
          })}</div>}
        </div>;
      })}
      <small>{H3_R2V_REFERENCE_HINT}</small>
    </div>}
    <div className="comfy-prompt-field">
    <CanvasTextarea fitContent className="comfy-video-prompt" aria-label="卡片指令" disabled={disabled}
      placeholder={mode === "reference" ? "用 <Picture 1> 指代参考图主体，不固定首尾画面…" : "输入画面动作、镜头调度与对白原文…"} value={prompt}
      readCurrentValue={readCurrentPrompt} onValueChange={onPromptChange} />
    </div>
    <div className="comfy-prompt-actions">{optimizationActions}</div>
    {mode !== "r2v" && <div className="comfy-audio-input" role="group" aria-label={audioLabel}
      onDragOver={event => {
        if (!disabled && getDragAssets()) { event.preventDefault(); event.stopPropagation(); }
      }}
      onDrop={event => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) void bindAudio(getDragAssets());
      }}>
      <div className="comfy-audio-row">
        <AudioLines size={14} aria-hidden="true" />
        <span>{audioLabel}</span>
        <span className="comfy-audio-source" title={audio?.name}>
          {audioBindings[0]?.videoAudio ? `${workflowVideoAudioLabel()} · ${videoAudioSourceName(audioBindings[0])}` : audio?.name ?? (audioBindings.length ? "等待读取音频" : "拖入或连接录音（可选）")}
        </span>
        {audioBindings.length > 0 && <button type="button" aria-label={`断开${audioLabel}`} title={`断开${audioLabel}`}
          disabled={disabled} onPointerDown={event => event.stopPropagation()}
          onClick={() => onChange({ inputs: { ...node.inputs, [H3_VIDEO_AUDIO_PORT]: [] } })}><X size={14} /></button>}
      </div>
      <small>{comfyAudioHint(mode)}</small>
    </div>}
  </section>;
}

const comfyImageSrc = (file: string) => file.startsWith("data:") ? file : convertFileSrc(file);
const imageCover = (asset?: Asset) => isVideoPath(asset?.thumb_path) ? undefined : asset?.thumb_path;
function frameImagePaths(asset?: Asset) {
  const originalImage = isVideoAsset(asset) ? undefined : asset?.store_path;
  return { path: imageCover(asset) || originalImage, originalImage };
}

function ComfyFrameThumbnail({ label, path, previewPath }: { label: string; path: string; previewPath: string }) {
  const [preview, setPreview] = useState(false);
  return <>
    <img className="comfy-frame-thumbnail" alt={label} src={comfyImageSrc(path)} draggable={false} tabIndex={0}
      onPointerEnter={() => setPreview(true)} onPointerLeave={() => setPreview(false)}
      onFocus={() => setPreview(true)} onBlur={() => setPreview(false)}
      onKeyDown={event => { if (event.key === "Escape" && preview) { event.stopPropagation(); setPreview(false); } }} />
    {preview && <img className="comfy-frame-preview" src={comfyImageSrc(previewPath)} alt="" aria-hidden="true" draggable={false} />}
  </>;
}
