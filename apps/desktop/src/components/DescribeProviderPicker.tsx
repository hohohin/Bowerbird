import { useEffect } from "react";
import { createPortal } from "react-dom";
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
      if (e.key === "Escape") closeDescribePicker();
    }
    function onDown(e: MouseEvent) {
      const panel = document.getElementById("describe-provider-picker");
      if (panel?.contains(e.target as Node)) return;
      closeDescribePicker();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
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
      ok: byoAllowed && !!codexHealth?.ok,
      reason: !byoAllowed ? "升级 Pro 解锁本机 codex" : codexHealth?.reason || "codex 不可用",
    },
  ];

  const x = Math.max(8, Math.min(picker.anchor.x, window.innerWidth - PANEL_WIDTH - 8));
  const y = Math.min(picker.anchor.y + 6, window.innerHeight - 160);

  return createPortal(
    <div
      id="describe-provider-picker"
      className="fixed z-50 overflow-hidden rounded-lg border border-edge bg-panel p-2 shadow-lg"
      style={{ left: x, top: y, width: PANEL_WIDTH }}
    >
      <div className="mb-1.5 px-1 text-[11px] text-muted">请选择反推引擎</div>
      <div className="flex flex-col gap-1">
        {options.map((opt) => (
          <button
            key={opt.key}
            type="button"
            disabled={!opt.ok}
            onClick={() => runDescribePicker(opt.key)}
            title={!opt.ok ? opt.reason : `用 ${opt.label} 反推`}
            className={
              "rounded px-2 py-1.5 text-left text-xs " +
              (opt.ok
                ? "bg-panel2 text-ink hover:bg-edge"
                : "cursor-not-allowed bg-panel text-muted opacity-50")
            }
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
