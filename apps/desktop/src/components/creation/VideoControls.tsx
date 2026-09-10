import { VIDEO_RATIOS, videoSupportsRatio, type VideoOptions } from "../../lib/videoGeneration";

export function VideoControls({ options, onChange, ratio, onRatioChange, channel = "jimeng", onChannelChange }: {
  options: VideoOptions; onChange: (options: VideoOptions) => void;
  ratio: string | null; onRatioChange: (ratio: string) => void;
  channel?: "jimeng" | "cloud"; onChannelChange?: (channel: "jimeng" | "cloud") => void;
}) {
  const control = "h-7 rounded border border-edge bg-panel2 px-2 text-xs text-ink";
  return <>
    <select aria-label="视频生成渠道" className={control} value={channel} onChange={event => onChannelChange?.(event.target.value as "jimeng" | "cloud")}>
      <option value="jimeng">即梦 · 会员积分</option><option value="cloud">方舟 · Bowerbird 积分</option>
    </select>
    <select aria-label="视频分辨率" className={control} value={options.video_resolution} onChange={event => onChange({ ...options, video_resolution: event.target.value as VideoOptions["video_resolution"] })}>
      {(channel === "cloud" ? ["480p", "720p", "1080p"] : ["480p", "720p"]).map(value => <option key={value} value={value}>{value}</option>)}
    </select>
    <select aria-label="视频生成模式" className={control} value={options.kind}
      onChange={(event) => onChange({ ...options, kind: event.target.value as VideoOptions["kind"] })}>
      <option value="text2video">文生视频</option>
      <option value="image2video">单图生视频</option>
      <option value="frames2video">首尾帧</option>
      <option value="multimodal2video">多参考</option>
    </select>
    <label className="flex items-center gap-1 text-xs text-muted">时长
      <input aria-label="视频时长（秒）" type="number" min={4} max={30} step={1} className={`${control} w-16`}
        value={options.duration} onChange={(event) => onChange({ ...options, duration: Number(event.target.value) })} />秒
    </label>
    {videoSupportsRatio(options) ? <select aria-label="视频比例" className={control} value={ratio || "16:9"}
      onChange={(event) => onRatioChange(event.target.value)}>
      {VIDEO_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
    </select> : <span className="text-[11px] text-muted">比例由{options.kind === "frames2video" ? "首帧" : "输入图"}决定</span>}
  </>;
}
