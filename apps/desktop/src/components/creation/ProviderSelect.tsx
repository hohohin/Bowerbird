import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AuthSnapshot, CodexHealth, EntitlementSnapshot } from "../../lib/types";
import { canUseByo } from "../../lib/entitlement";

/** 出图 provider 选项（codex / 即梦 / Bowerbird Cloud）。 */
const PROVIDERS = [
  { key: "codex", label: "codex" },
  { key: "jimeng", label: "即梦" },
  { key: "bowerbird-cloud", label: "Bowerbird Cloud" },
] as const;

/**
 * 出图 provider 下拉选择。选项使用定宽浮层，不参与创作板正文布局；每个 provider 按各自
 * 健康状态置灰（约定 7）：未就绪 disabled + tooltip 显 reason。
 */
export function ProviderSelect({
  value,
  onChange,
  codexHealth,
  dreaminaHealth,
  cloudAvailable = false,
  cloudAuth = null,
  cloudEntitlement = null,
}: {
  value: string;
  onChange: (p: string) => void;
  codexHealth: CodexHealth | null;
  dreaminaHealth: CodexHealth | null;
  cloudAvailable?: boolean;
  cloudAuth?: AuthSnapshot | null;
  cloudEntitlement?: EntitlementSnapshot | null;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = PROVIDERS.find((p) => p.key === value) ?? PROVIDERS[0];

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-[3px] border border-edge bg-panel2 px-2 text-xs text-ink outline-none hover:border-accent/60 hover:bg-edge focus:border-accent"
        title="选择出图引擎"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current.label}</span>
        <ChevronDown size={12} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="app-popover absolute bottom-full left-0 z-30 mb-1 w-56 p-1.5"
          role="listbox"
          aria-label="出图引擎"
        >
          <div className="app-popover-title">出图引擎</div>
          {PROVIDERS.map((p) => {
            const isCloud = p.key === "bowerbird-cloud";
            const isByo = !isCloud;
            const byoLocked = isByo && !canUseByo(cloudEntitlement);
            const health = p.key === "jimeng" ? dreaminaHealth : codexHealth;
            const cloudBalance = cloudEntitlement
              ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
              : 0;
            const reason = isCloud
              ? !cloudAvailable
                ? "当前版本未配置 Bowerbird Cloud"
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
                title={!ok ? reason || health?.reason || `${p.label} 不可用` : `用 ${p.label} 出图`}
                className={`app-popover-option provider-select-option px-2 text-xs ${selected ? "bg-panel2 text-ink" : ""}`}
                role="option"
                aria-selected={selected}
              >
                <span className={`app-status-dot ${ok ? "is-ready" : ""}`} />
                <span className="min-w-0 flex-1 truncate">{p.label}</span>
                {selected && <Check size={13} className="text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
