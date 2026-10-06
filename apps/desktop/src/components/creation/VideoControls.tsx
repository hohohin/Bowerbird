import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { VIDEO_RATIOS, videoDurationRange, videoResolutions, videoSupportsRatio, type VideoModelCapability, type VideoOptions } from "../../lib/videoGeneration";
import { DreaminaBalance } from "./DreaminaCredits";

export function VideoControls({ options, onChange, ratio, onRatioChange, channel = "jimeng", onChannelChange }: {
  options: VideoOptions; onChange: (options: VideoOptions) => void;
  ratio: string | null; onRatioChange: (ratio: string) => void;
  channel?: "jimeng" | "cloud"; onChannelChange?: (channel: "jimeng" | "cloud") => void;
}) {
  const control = "h-7 rounded border border-edge bg-panel2 px-2 text-xs text-ink";
  const [catalog, setCatalog] = useState<{ kind: string; models: VideoModelCapability[]; error?: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (channel !== "jimeng") return;
    let active = true;
    setCatalog(null);
    void api.dreaminaVideoModels(options.kind).then(models => { if (active) setCatalog({ kind: options.kind, models }); })
      .catch(error => { if (active) setCatalog({ kind: options.kind, models: [], error: String(error) }); });
    return () => { active = false; };
  }, [channel, options.kind, refresh]);
  const models = catalog?.kind === options.kind ? catalog.models : [];
  const selected = models.find(model => model.model_version === options.model_version);
  const resolutions = channel === "cloud" ? videoResolutions("seedance2.5") : selected?.resolutions ?? [];
  const [minDuration, maxDuration] = selected ? [selected.min_duration, selected.max_duration] : videoDurationRange(options.model_version);
  return <>
    <select aria-label="视频生成渠道" className={control} value={channel} onChange={event => {
      const next = event.target.value as "jimeng" | "cloud";
      onChannelChange?.(next);
    }}>
      <option value="jimeng">即梦 · 会员积分</option><option value="cloud">方舟 · Bowerbird 积分</option>
    </select>
    <select aria-label="视频模型" className={control} value={options.model_version} disabled={channel === "cloud" || !models.length} onChange={event => {
      const model = models.find(item => item.model_version === event.target.value);
      if (model) onChange({ ...options, model_version: model.model_version,
        video_resolution: model.resolutions.includes(options.video_resolution) ? options.video_resolution : model.resolutions[0],
        duration: Math.min(model.max_duration, Math.max(model.min_duration, options.duration)) });
    }}>
      {channel === "cloud" ? <option value="seedance2.5">Seedance 2.5</option> : <>
        {!selected && <option value={options.model_version}>{options.model_version} · {models.length ? "当前模式不支持" : "待核验"}</option>}
        {models.map(model => <option key={model.model_version} value={model.model_version}>{model.model_version.replace("seedance", "Seedance ").replace("_vip", " · VIP")}</option>)}
      </>}
    </select>
    {channel === "jimeng" && catalog?.error && <button type="button" title={catalog.error} className="text-[11px] text-muted underline" onClick={() => setRefresh(value => value + 1)}>模型查询失败，重试</button>}
    <select aria-label="视频分辨率" className={control} value={options.video_resolution} onChange={event => onChange({ ...options, video_resolution: event.target.value as VideoOptions["video_resolution"] })}>
      {!resolutions.includes(options.video_resolution) && <option value={options.video_resolution}>{options.video_resolution} · 待核验</option>}
      {resolutions.map(value => <option key={value} value={value}>{value}</option>)}
    </select>
    <select aria-label="视频生成模式" className={control} value={options.kind}
      onChange={(event) => onChange({ ...options, kind: event.target.value as VideoOptions["kind"] })}>
      <option value="text2video">文生视频</option>
      <option value="image2video">单图生视频</option>
      <option value="frames2video">首尾帧</option>
      <option value="multimodal2video">多参考</option>
    </select>
    <label className="flex items-center gap-1 text-xs text-muted">时长
      <input aria-label="视频时长（秒）" type="number" min={minDuration} max={maxDuration} step={1} className={`${control} w-16`}
        value={options.duration} onChange={(event) => onChange({ ...options, duration: Number(event.target.value) })} />秒
    </label>
    {videoSupportsRatio(options) ? <select aria-label="视频比例" className={control} value={ratio || "16:9"}
      onChange={(event) => onRatioChange(event.target.value)}>
      {VIDEO_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
    </select> : <span className="text-[11px] text-muted">比例由{options.kind === "frames2video" ? "首帧" : "输入图"}决定</span>}
    {channel === "jimeng" && <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1"><DreaminaBalance /><span className="text-[11px] text-muted">暂无官方生成前报价；提交后显示任务消耗</span></div>}
  </>;
}
