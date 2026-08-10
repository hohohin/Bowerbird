import { useState } from "react";
import type { AuthSnapshot, CodexHealth, EntitlementSnapshot } from "../../lib/types";
import { canUseByo } from "../../lib/entitlement";

/** 出图 provider 选项（codex / 即梦 / Bowerbird Cloud）。 */
const PROVIDERS = [
  { key: "codex", label: "codex" },
  { key: "jimeng", label: "即梦" },
  { key: "bowerbird-cloud", label: "Bowerbird Cloud" },
] as const;

/**
 * 出图 provider 下拉选择（按钮 toggle + 下方 inline 选项面板，与 RatioSelect 同范式，
 * 项目零浮层先例）。触发按钮与 RatioSelect 等高（h-7）。每个 provider 按各自健康状态置灰
 * （约定 7）：未就绪 disabled + tooltip 显 reason。
 */
export function ProviderSelect({
  value,
  onChange,
  codexHealth,
  dreaminaHealth,
  cloudEnabled = false,
  cloudAuth = null,
  cloudEntitlement = null,
}: {
  value: string;
  onChange: (p: string) => void;
  codexHealth: CodexHealth | null;
  dreaminaHealth: CodexHealth | null;
  cloudEnabled?: boolean;
  cloudAuth?: AuthSnapshot | null;
  cloudEntitlement?: EntitlementSnapshot | null;
}) {
  const [open, setOpen] = useState(false);
  const current = PROVIDERS.find((p) => p.key === value) ?? PROVIDERS[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1 rounded bg-panel2 px-2 text-xs text-ink outline-none ring-1 ring-edge hover:bg-edge focus:ring-accent"
        title="选择出图引擎"
      >
        <span>{current.label}</span>
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="mt-1 flex flex-col gap-1 rounded bg-panel2 p-2">
          {PROVIDERS.map((p) => {
            const isCloud = p.key === "bowerbird-cloud";
            const isByo = !isCloud;
            const byoLocked = isByo && !canUseByo(cloudEntitlement);
            const health = p.key === "jimeng" ? dreaminaHealth : codexHealth;
            const cloudBalance = cloudEntitlement
              ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
              : 0;
            const reason = isCloud
              ? !cloudEnabled
                ? "Bowerbird Cloud 未启用"
                : !cloudAuth?.logged_in
                  ? "请先登录 Bowerbird 账号"
                  : cloudBalance <= 0
                    ? "积分不足"
                    : undefined
              : byoLocked
                ? "升级 Pro 解锁 BYO 引擎"
                : undefined;
            const ok = isCloud ? reason === undefined : byoLocked ? false : !!health?.ok;
            const selected = value === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  if (ok) {
                    onChange(p.key);
                    setOpen(false);
                  }
                }}
                disabled={!ok}
                title={!ok ? (isCloud ? reason : health?.reason) || `${p.label} 不可用` : `用 ${p.label} 出图`}
                className={
                  "rounded px-2 py-1 text-left text-xs " +
                  (selected
                    ? "bg-accent font-semibold text-black"
                    : ok
                    ? "bg-panel text-ink hover:bg-edge"
                    : "cursor-not-allowed bg-panel text-muted opacity-40")
                }
              >
                {p.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto shrink-0 self-end rounded px-1 text-muted hover:bg-panel hover:text-ink"
            title="收起"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
