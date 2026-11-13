import { generationProviderIssue } from "../../lib/generationAvailability";
import { useStore } from "../../store";
import { SELECTABLE_VIDEO_MODELS, VIDEO_RATIOS, videoDurationRange, videoModelLabel, videoProvider, videoResolutions, videoSupportsRatio, type VideoOptions } from "../../lib/videoGeneration";
import { DreaminaBalance } from "./DreaminaCredits";
import { ModelSelect, type ModelOption } from "./ModelSelect";
import { TacticalSelect } from "../TacticalSelect";
import { canUseComfyVideo, comfyVideoMode, comfyVideoOptionsForMode, type ComfyVideoMode, type ComfyVideoOptions } from "../../lib/comfyVideo";

type VideoChannel = "jimeng" | "cloud";
export function VideoControls({ options, onChange, ratio, onRatioChange, channel = "jimeng", composer = false, local, menuClassName }: {
  options: VideoOptions; onChange: (options: VideoOptions, channel?: VideoChannel) => void;
  ratio: string | null; onRatioChange: (ratio: string) => void;
  channel?: VideoChannel; composer?: boolean; menuClassName?: string;
  local?: { options?: ComfyVideoOptions; onSelect: () => void; onChange: (options: ComfyVideoOptions) => void };
}) {
  const control = "h-7 rounded border border-edge bg-panel2 px-2 text-xs text-ink";
  const entitlement = useStore(state => state.cloudEntitlement);
  const auth = useStore(state => state.cloudAuth);
  const health = useStore(state => state.dreaminaHealth);
  const availability = { cloudAuth: auth, cloudEntitlement: entitlement, dreaminaHealth: health, codexHealth: null };
  const model = channel === "cloud" ? "seedance2.5" : options.model_version;
  const resolutions = videoResolutions(model);
  const [minDuration, maxDuration] = videoDurationRange(model);
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const cloudReason = generationProviderIssue(videoProvider("cloud", options), availability)?.message;
  const personalReason = generationProviderIssue("jimeng", availability)?.message;
  const modelOptions: ModelOption[] = SELECTABLE_VIDEO_MODELS.map(model => ({ key: `jimeng:${model}`, label: videoModelLabel(model), source: "personal",
    reason: personalReason }));
  modelOptions.push({ key: "cloud:seedance2.5", label: "Seedance 2.5", source: "cloud", reason: cloudReason });
  if (local) modelOptions.push({ key: "local:h3", label: "本地部署 · H3", source: "local", reason: canUseComfyVideo(auth, entitlement) ? undefined : "本地 H3 需要有效的 Pro／Studio 权益或测试账号资格" });
  function selectModel(key: string) {
    if (key === "local:h3") { local?.onSelect(); return; }
    const [nextChannel, version] = key.split(":") as [VideoChannel, string];
    const allowed = videoResolutions(version);
    const fallbackResolution = allowed.includes("720p") ? "720p" : allowed[0];
    const [min, max] = videoDurationRange(version);
    onChange({ ...options, model_version: version, duration: Math.min(max, Math.max(min, options.duration)),
      video_resolution: allowed.includes(options.video_resolution) ? options.video_resolution : fallbackResolution }, nextChannel);
  }
  const status = !local?.options && channel === "jimeng" && <>
    {channel === "jimeng" && <><DreaminaBalance /><span className="text-[11px] text-muted">暂无官方生成前报价；提交后显示任务消耗</span></>}
  </>;
  const fields = <>
    <ModelSelect kind="视频" menuClassName={menuClassName} value={local?.options ? "local:h3" : `${channel}:${options.model_version}`} label={local?.options ? (composer ? "H3" : "本地部署 · H3") : videoModelLabel(options.model_version)} source={local?.options ? "local" : channel === "cloud" ? "cloud" : "personal"}
      cloudBalance={entitlement ? balance : null} cloudLoggedIn={auth?.logged_in}
      options={modelOptions} onChange={selectModel} footer={composer ? status : undefined} quotaDetail={local?.options ? "本地 H3 视频，不消耗积分" : channel === "cloud" ? "使用 Bowerbird 账号积分" : "使用自有即梦账号额度，不扣 Bowerbird 积分"} />
    {local?.options ? <>
      <TacticalSelect aria-label="本地视频模式" value={comfyVideoMode(local.options)} onValueChange={value => local.onChange(comfyVideoOptionsForMode(local.options!, value as ComfyVideoMode))}><option value="frames">首尾帧</option><option value="reference">单图</option><option value="text">文生视频</option></TacticalSelect>
      <TacticalSelect aria-label="本地视频分辨率" value={local.options.resolution} onValueChange={value => local.onChange({ ...local.options!, resolution: Number(value) as ComfyVideoOptions["resolution"] })}>{(comfyVideoMode(local.options) === "frames" ? [0.6, 0.8, 1] : [0.6, 0.8, 0.98, 1]).map(value => <option key={value} value={value}>{value === 0.98 ? "768p" : `${value} MP`}</option>)}</TacticalSelect>
      <label className="flex items-center gap-1 text-xs text-muted"><input aria-label="本地视频时长（秒）" type="number" min={1} max={15} step={1} className={`${control} w-12`} value={local.options.seconds} onChange={event => local.onChange({ ...local.options!, seconds: Number(event.target.value) })} />秒</label>
      <TacticalSelect aria-label="本地视频比例" value={local.options.ratio} onValueChange={value => local.onChange({ ...local.options!, ratio: value as ComfyVideoOptions["ratio"] })}>{[...(comfyVideoMode(local.options) === "text" ? [] : ["auto"]), "9:16", "16:9", "4:3", "3:4", "1:1"].map(value => <option key={value} value={value}>{value === "auto" ? "自动" : value}</option>)}</TacticalSelect>
    </> : <>
    <TacticalSelect aria-label="视频分辨率" className={control} value={options.video_resolution} onValueChange={value => onChange({ ...options, video_resolution: value as VideoOptions["video_resolution"] })}>
      {!resolutions.includes(options.video_resolution) && <option value={options.video_resolution} disabled>{options.video_resolution} · 不支持</option>}
      {resolutions.map(value => <option key={value} value={value}>{value}</option>)}
    </TacticalSelect>
    <TacticalSelect aria-label="视频生成模式" title={options.kind === "frames2video" ? "按参考顺序使用首帧、尾帧" : `自动识别：${options.kind === "text2video" ? "文生视频" : options.kind === "image2video" ? "单图生视频" : "多参考"}`} className={control} value={options.kind === "frames2video" ? "frames2video" : "auto"} onValueChange={value => onChange({ ...options, kind: value === "frames2video" ? "frames2video" : "text2video" })}>
      <option value="auto">{composer ? "自动" : "自动识别"}</option><option value="frames2video">首尾帧</option>
    </TacticalSelect>
    <label className="flex items-center gap-1 text-xs text-muted"><span className="video-duration-label">时长</span><input aria-label="视频时长（秒）" type="number" min={minDuration} max={maxDuration} step={1} className={`${control} w-16`}
      value={options.duration} onChange={event => onChange({ ...options, duration: Number(event.target.value) })} />秒</label>
    {videoSupportsRatio(options) ? <TacticalSelect aria-label="视频比例" className={control} value={ratio || "16:9"} onValueChange={value => onRatioChange(value)}>
      {VIDEO_RATIOS.map(value => <option key={value} value={value}>{value}</option>)}
    </TacticalSelect> : <span className="text-[11px] text-muted">比例由{options.kind === "frames2video" ? "首帧" : "输入图"}决定</span>}
    </>}
  </>;
  return <>
    {composer ? <div className={`composer-video-fields${local?.options ? " is-local" : ""}`}>{fields}</div> : fields}
    {!composer && status && <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">{status}</div>}
  </>;
}
