import type { DshSkill } from "../../lib/dshSkill";
import { TacticalSelect } from "../TacticalSelect";

export function DshSkillSelect({ value, onChange, available, disabled }: {
  value?: DshSkill; onChange: (value?: DshSkill) => void; available: boolean; disabled?: boolean;
}) {
  if (!available && !value) return null;
  const p = value?.id === "h3-video-prompt" ? value.parameters : undefined;
  return <div className="flex flex-wrap items-center gap-1">
    <TacticalSelect aria-label="云端技能" value={value?.id ?? ""} disabled={disabled} onValueChange={id => {
      if (id === "text-editor") onChange({ id });
      else if (id === "h3-video-prompt") onChange({ id, parameters: { mode: "text", seconds: 5, ratio: "9:16", firstFrameCount: 0, lastFrameCount: 0 } });
      else onChange(undefined);
    }}>
      <option value="">普通对话</option>
      <option disabled={!available} value="text-editor">文本编辑</option>
      <option disabled={!available} value="h3-video-prompt">H3 视频提示词</option>
    </TacticalSelect>
    {p && <>
      <TacticalSelect aria-label="视频素材" disabled={disabled || !available} value={p.lastFrameCount ? "both" : p.mode} onValueChange={choice => {
        const mode = choice === "text" || choice === "reference" ? choice : "frames";
        onChange({ id: "h3-video-prompt", parameters: { ...p, mode, firstFrameCount: mode === "text" ? 0 : 1, lastFrameCount: choice === "both" ? 1 : 0 } });
      }}>
        <option value="text">文生视频</option><option value="reference">参考图</option><option value="frames">首帧</option><option value="both">首尾帧</option>
      </TacticalSelect>
      <TacticalSelect aria-label="画面比例" disabled={disabled || !available} value={p.ratio} onValueChange={ratio => onChange({ id: "h3-video-prompt", parameters: { ...p, ratio: ratio as typeof p.ratio } })}>
        {(["9:16", "16:9", "4:3", "3:4", "1:1", "auto"] as const).map(ratio => <option key={ratio} value={ratio}>{ratio === "auto" ? "自动比例" : ratio}</option>)}
      </TacticalSelect>
      <label><input aria-label="视频时长" type="number" min="1" max="120" className="w-12" disabled={disabled || !available} value={p.seconds} onChange={event => {
        const seconds = event.currentTarget.valueAsNumber;
        if (seconds > 0 && seconds <= 120) onChange({ id: "h3-video-prompt", parameters: { ...p, seconds } });
      }} /> 秒</label>
    </>}
  </div>;
}
