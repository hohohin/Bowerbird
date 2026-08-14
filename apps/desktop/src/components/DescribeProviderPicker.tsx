import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Cloud, Laptop2 } from "lucide-react";
import { useStore } from "../store";
import { canUseByo } from "../lib/entitlement";

const PANEL_WIDTH = 240;

/**
 * 反推引擎选择浮层（全局单例，store.describePicker 驱动）。
 *
 * 三个反推入口（批量 BatchBar / 右键 AssetContextMenu / 详情页 AssetDetail）各自打开它：
 * 用户选 Bowerbird Cloud 或 本机 codex 后，由 store.runDescribePicker 执行任务。
 * dreamina 无文本能力（caption:false），不出现在选项里。
 *
 * 门控（参考 creation/ProviderSelect）：Cloud 需可用+已登录+积分>0；codex 需 Pro+ 且本机就绪。
 * 未就绪项置灰 + hover 显原因。
 */
export function DescribeProviderPicker() {
  const picker = useStore((s) => s.describePicker);
  const closeDescribePicker = useStore((s) => s.closeDescribePicker);
  const runDescribePicker = useStore((s) => s.runDescribePicker);
  const codexHealth = useStore((s) => s.codexHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);

  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const cloudBalance = cloudEntitlement
    ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup
    : 0;
  const byoAllowed = canUseByo(cloudEntitlement);

  useEffect(() => {
    if (!picker) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeDescribePicker();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>("#describe-provider-picker button:not(:disabled)")
      );
      if (buttons.length === 0) return;
      e.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const offset = e.key === "ArrowDown" ? 1 : -1;
      buttons[(current + offset + buttons.length) % buttons.length].focus();
    }
    function onDown(e: MouseEvent) {
      const panel = document.getElementById("describe-provider-picker");
      if (panel?.contains(e.target as Node)) return;
      closeDescribePicker();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("#describe-provider-picker button:not(:disabled)")?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [picker, closeDescribePicker]);

  if (!picker) return null;

  const options = [
    {
      key: "bowerbird-cloud",
      label: "Bowerbird Cloud",
      icon: Cloud,
      ok: cloudAvailable && !!cloudAuth?.logged_in && cloudBalance > 0,
      reason: !cloudAvailable
        ? "当前版本未配置 Bowerbird Cloud"
        : !cloudAuth?.logged_in
          ? "请先登录 Bowerbird 账号"
          : cloudBalance <= 0
            ? "积分不足"
            : undefined,
    },
    {
      key: "codex",
      label: "本机 codex",
      icon: Laptop2,
      ok: byoAllowed && !!codexHealth?.ok,
      reason: !byoAllowed ? "升级 Pro 解锁本机 codex" : codexHealth?.reason || "codex 不可用",
    },
  ];

  const x = Math.max(8, Math.min(picker.anchor.x, window.innerWidth - PANEL_WIDTH - 8));
  const y = Math.max(8, Math.min(picker.anchor.y + 6, window.innerHeight - 196));

  return createPortal(
    <div
      id="describe-provider-picker"
      className="app-popover fixed z-[70]"
      style={{ left: x, top: y, width: PANEL_WIDTH }}
      role="menu"
      aria-label="选择反推引擎"
    >
      <div className="app-popover-title">选择反推引擎</div>
      {options.map((opt) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.key}
            type="button"
            role="menuitem"
            disabled={!opt.ok}
            onClick={() => runDescribePicker(opt.key)}
            title={!opt.ok ? opt.reason : `用 ${opt.label} 反推`}
            className="app-popover-option"
          >
            <Icon size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium">{opt.label}</span>
              <span className="mt-0.5 block truncate text-[10px] text-muted">
                {opt.ok ? "当前可用" : opt.reason}
              </span>
            </span>
            <span className={`app-status-dot ${opt.ok ? "is-ready" : ""}`} aria-hidden="true" />
          </button>
        );
      })}
    </div>,
    document.body
  );
}
