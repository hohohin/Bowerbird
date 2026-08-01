import type { CodexHealth } from "../../lib/types";

/** 出图 provider 选项（Phase 3：codex / 即梦）。 */
const PROVIDERS = [
  { key: "codex", label: "codex" },
  { key: "jimeng", label: "即梦" },
] as const;

/**
 * 出图 provider inline 切换（segmented 按钮组，非下拉——项目零浮层先例，2 选项够用）。
 * 每个 provider 按各自健康状态置灰（约定 7）：未就绪 disabled + tooltip 显 reason。
 * 复用：CreationBoard 选 activeGenProvider（当前会话）、SettingsDialog 选 defaultProvider（全局默认）。
 */
export function ProviderSelect({
  value,
  onChange,
  codexHealth,
  dreaminaHealth,
}: {
  value: string;
  onChange: (p: string) => void;
  codexHealth: CodexHealth | null;
  dreaminaHealth: CodexHealth | null;
}) {
  return (
    <div className="flex items-center gap-1">
      {PROVIDERS.map((p) => {
        const health = p.key === "jimeng" ? dreaminaHealth : codexHealth;
        const ok = !!health?.ok;
        const selected = value === p.key;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => ok && onChange(p.key)}
            disabled={!ok}
            title={!ok ? health?.reason || `${p.label} 不可用` : `用 ${p.label} 出图`}
            className={`rounded px-2 py-0.5 text-[11px] ${
              selected
                ? "bg-accent font-semibold text-black"
                : "bg-panel text-muted hover:bg-edge hover:text-ink"
            } ${!ok ? "cursor-not-allowed opacity-40" : ""}`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
