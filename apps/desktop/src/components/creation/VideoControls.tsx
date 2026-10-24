import { userErrorMessage } from "../../lib/userError";
import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { api } from "../../lib/api";
import { useStore } from "../../store";
import { canUseByo } from "../../lib/entitlement";
import { SELECTABLE_VIDEO_MODELS, VIDEO_RATIOS, videoDurationRange, videoModelLabel, videoResolutions, videoSupportsRatio, type VideoModelCapability, type VideoOptions } from "../../lib/videoGeneration";
import { DreaminaBalance } from "./DreaminaCredits";
import { ModelSelect, type ModelOption } from "./ModelSelect";
import { canUseComfyVideo, type ComfyVideoOptions } from "../../lib/comfyVideo";

type VideoChannel = "jimeng" | "cloud";
export function VideoControls({ options, onChange, ratio, onRatioChange, channel = "jimeng", composer = false, local }: {
  options: VideoOptions; onChange: (options: VideoOptions, channel?: VideoChannel) => void;
  ratio: string | null; onRatioChange: (ratio: string) => void;
  channel?: VideoChannel; composer?: boolean;
  local?: { options?: ComfyVideoOptions; onSelect: () => void; onChange: (options: ComfyVideoOptions) => void };
}) {
  const control = "h-7 rounded border border-edge bg-panel2 px-2 text-xs text-ink";
  const entitlement = useStore(state => state.cloudEntitlement);
  const auth = useStore(state => state.cloudAuth);
  const health = useStore(state => state.dreaminaHealth);
  const byo = canUseByo(entitlement);
  const [catalog, setCatalog] = useState<{ kind: string; models: VideoModelCapability[]; error?: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!byo || !health?.ok) { setCatalog(null); return; }
    let active = true;
    setCatalog(null);
    void api.dreaminaVideoModels(options.kind).then(models => { if (active) setCatalog({ kind: options.kind, models }); })
      .catch(error => { if (active) setCatalog({ kind: options.kind, models: [], error: String(error) }); });
    return () => { active = false; };
  }, [options.kind, refresh, byo, health?.ok]);
  const current = catalog?.kind === options.kind ? catalog : null;
  const models = current?.models ?? [];
  const selected = models.find(model => model.model_version === options.model_version);
  const resolutions = channel === "cloud" ? videoResolutions("seedance2.5") : selected?.resolutions ?? [];
  const [minDuration, maxDuration] = selected && channel === "jimeng" ? [selected.min_duration, selected.max_duration] : videoDurationRange(options.model_version);
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : 0;
  const cloudReason = !auth?.cloud_available ? "当前版本未配置 Bowerbird Cloud" : !auth.logged_in ? "请先登录 Bowerbird 账号" : balance <= 0 ? "积分不足" : undefined;
  const modelOptions: ModelOption[] = SELECTABLE_VIDEO_MODELS.map(model => ({ key: `jimeng:${model}`, label: videoModelLabel(model), source: "personal",
    reason: !byo ? "升级 Pro 解锁自有订阅" : !health?.ok ? userErrorMessage(health?.reason, "请先登录即梦账号") : !current ? "正在查询当前模式支持的模型" : current.error ? "模型查询失败，请重试" : !models.some(item => item.model_version === model) ? "当前模式或账号不支持此模型" : undefined }));
  modelOptions.push({ key: "cloud:seedance2.5", label: "Seedance 2.5", source: "cloud", reason: cloudReason });
  if (local) modelOptions.push({ key: "local:h3", label: "本地部署 · H3", source: "local", reason: canUseComfyVideo(auth, entitlement) ? undefined : "本地 H3 需要有效的 Pro／Studio 权益或测试账号资格" });
  function selectModel(key: string) {
    if (key === "local:h3") { local?.onSelect(); return; }
    const [nextChannel, version] = key.split(":") as [VideoChannel, string];
    const capability = models.find(model => model.model_version === version);
    const allowed = nextChannel === "cloud" ? videoResolutions(version) : capability!.resolutions;
    const fallbackResolution = allowed.includes("720p") ? "720p" : allowed[0];
    const [min, max] = nextChannel === "cloud" ? videoDurationRange(version) : [capability!.min_duration, capability!.max_duration];
    onChange({ ...options, model_version: version, duration: Math.min(max, Math.max(min, options.duration)),
      video_resolution: allowed.includes(options.video_resolution) ? options.video_resolution : fallbackResolution }, nextChannel);
  }
  const status = !local?.options && (channel === "jimeng" || current?.error) && <>
    {channel === "jimeng" && <><DreaminaBalance /><span className="text-[11px] text-muted">暂无官方生成前报价；提交后显示任务消耗</span></>}
    {current?.error && <button type="button" title={userErrorMessage(current.error, "暂时无法查询可用模型，请点击重试。")} className="text-[11px] text-muted underline" onClick={() => setRefresh(value => value + 1)}>模型查询失败，重试</button>}
  </>;
  const fields = <>
    <ModelSelect kind="视频" value={local?.options ? "local:h3" : `${channel}:${options.model_version}`} label={local?.options ? "本地部署 · H3" : videoModelLabel(options.model_version)} source={local?.options ? "local" : channel === "cloud" ? "cloud" : "personal"}
      cloudBalance={entitlement ? balance : null} cloudLoggedIn={auth?.logged_in}
      options={modelOptions} onChange={selectModel} footer={composer ? status : undefined} quotaDetail={local?.options ? "本地 H3 视频，不消耗积分" : channel === "cloud" ? "使用 Bowerbird 账号积分" : "使用自有即梦账号额度，不扣 Bowerbird 积分"} />
    {local?.options ? <>
      <select aria-label="本地视频分辨率" value={local.options.resolution} onChange={event => local.onChange({ ...local.options!, resolution: Number(event.target.value) as ComfyVideoOptions["resolution"] })}>{[0.6, 0.8, 1].map(value => <option key={value} value={value}>{value} MP</option>)}</select>
      <label className="flex items-center gap-1 text-xs text-muted"><input aria-label="本地视频时长（秒）" type="number" min={1} max={15} step={1} className={`${control} w-12`} value={local.options.seconds} onChange={event => local.onChange({ ...local.options!, seconds: Number(event.target.value) })} />秒</label>
      <select aria-label="本地视频比例" value={local.options.ratio} onChange={event => local.onChange({ ...local.options!, ratio: event.target.value as ComfyVideoOptions["ratio"] })}>{["auto", "9:16", "16:9", "4:3", "3:4", "1:1"].map(value => <option key={value} value={value}>{value === "auto" ? "自动" : value}</option>)}</select>
    </> : <>
    <select aria-label="视频分辨率" className={control} value={options.video_resolution} onChange={event => onChange({ ...options, video_resolution: event.target.value as VideoOptions["video_resolution"] })}>
      {!resolutions.includes(options.video_resolution) && <option value={options.video_resolution}>{options.video_resolution} · 待核验</option>}
      {resolutions.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
    <select aria-label="视频生成模式" className={control} value={options.kind} onChange={event => onChange({ ...options, kind: event.target.value as VideoOptions["kind"] })}>
      <option value="text2video">文生视频</option><option value="image2video">单图生视频</option><option value="frames2video">首尾帧</option><option value="multimodal2video">多参考</option>
    </select>
    <label className="flex items-center gap-1 text-xs text-muted">时长<input aria-label="视频时长（秒）" type="number" min={minDuration} max={maxDuration} step={1} className={`${control} w-16`}
      value={options.duration} onChange={event => onChange({ ...options, duration: Number(event.target.value) })} />秒</label>
    {videoSupportsRatio(options) ? <select aria-label="视频比例" className={control} value={ratio || "16:9"} onChange={event => onRatioChange(event.target.value)}>
      {VIDEO_RATIOS.map(value => <option key={value} value={value}>{value}</option>)}
    </select> : <span className="text-[11px] text-muted">比例由{options.kind === "frames2video" ? "首帧" : "输入图"}决定</span>}
    </>}
  </>;
  return <>
    {composer ? <div className="composer-video-fields">{fields}</div> : fields}
    {composer ? current?.error && <button type="button" className="composer-video-retry" aria-label="模型查询失败，重试" title={userErrorMessage(current.error, "模型查询失败，请点击重试。")} onClick={() => setRefresh(value => value + 1)}><RotateCw size={14} aria-hidden="true" /></button>
      : status && <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">{status}</div>}
  </>;
}
