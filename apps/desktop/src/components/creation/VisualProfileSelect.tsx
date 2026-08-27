import { Palette } from "lucide-react";
import { useStore } from "../../store";

export function VisualProfileSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const profiles = useStore((state) => state.visualProfiles).filter(
    (profile) => profile.status === "confirmed",
  );
  if (profiles.length === 0) return null;

  return (
    <label
      className="flex h-7 items-center gap-1 rounded-[3px] border border-edge bg-panel2 px-2 text-[11px] text-muted"
      title={disabled
        ? "该会话已冻结启动时的视觉设定版本"
        : "项目视觉设定只补充本次任务未说明的视觉选择；本次明确要求始终优先"}
    >
      <Palette size={12} className="shrink-0 text-accent" />
      <select
        aria-label="项目视觉设定"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="max-w-36 bg-transparent text-[11px] text-ink outline-none disabled:opacity-60"
      >
        <option value="">不使用视觉设定</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name} · v{profile.version}
          </option>
        ))}
      </select>
    </label>
  );
}
