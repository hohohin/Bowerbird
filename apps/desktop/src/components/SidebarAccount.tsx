import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Coins, LogIn, LogOut, Settings, Zap } from "lucide-react";
import { useStore } from "../store";
import { understandReady } from "../lib/entitlement";
import { SettingsDialog } from "./SettingsDialog";

/**
 * 共用账号入口：顶栏将头像与 Bcoin 合为账号面板入口，旧侧栏保留菜单。
 * 已登录 → 升级账号（应用内账号管理）/ 设置 / 登出；未登录 → 登录 Bowerbird 账号 / 设置。
 * 账号详情（账号名 / 积分明细 / 升级）已移入设置面板「账号管理」。
 */
export function SidebarAccount({ collapsed = false, onInteractionChange, placement = "sidebar" }: {
  placement?: "sidebar" | "topbar";
  collapsed?: boolean;
  onInteractionChange?: (active: boolean) => void;
}) {
  const topbar = placement === "topbar";
  const compact = topbar || collapsed;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const logoutCloud = useStore((s) => s.logoutCloud);
  const setAccountOnboardingForceOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const codexHealth = useStore((s) => s.codexHealth);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"system" | "account">("system");
  const rootRef = useRef<HTMLDivElement>(null);

  const loggedIn = cloudAuth?.logged_in === true;
  const balances = cloudEntitlement?.balances;
  const credits = loggedIn && balances ? balances.daily + balances.sub + balances.topup : null;
  const creditsText = credits == null ? "—" : credits.toLocaleString("zh-CN");
  const creditsLabel = !loggedIn ? "登录后查看 Bcoin" : credits == null ? "Bcoin 余额暂不可用" : `可用 Bcoin：${creditsText}`;
  const name = cloudAuth?.display_name || cloudAuth?.email || cloudAuth?.user_id || "";
  const avatarUrl = cloudAuth?.avatar_url ?? null;
  const tier = cloudEntitlement?.tier?.toUpperCase() ?? "";
  // 旧版本浏览器扩展不再参与未就绪提醒。
  const hasIssue = !understandReady({ entitlement: cloudEntitlement, codexHealth, cloudAuth });

  useEffect(() => {
    onInteractionChange?.(open || settingsOpen);
    return () => onInteractionChange?.(false);
  }, [open, settingsOpen, onInteractionChange]);

  function openAccountDetail() {
    setOpen(false);
    setAccountOnboardingForceOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const frame = topbar ? requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()) : null;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    }
    function onMouseDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, topbar]);

  return (
    <div ref={rootRef} className={topbar ? "topbar-account" : `relative border-t border-edge px-1 pb-1 pt-2 ${collapsed ? "mt-auto w-full" : "mt-2"}`}>
      {open && (
        <div className={`app-popover mb-1.5 flex flex-col gap-0.5 ${topbar ? "topbar-account-menu" : collapsed ? "absolute bottom-full left-1 z-[60] w-56" : ""}`} role="menu" aria-label="账号与设置">
          {loggedIn ? (
            <>
              <div className="px-2 py-1 text-[11px] text-muted">
                {name}
                {tier && <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tier}</span>}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSettingsSection("account");
                  setSettingsOpen(true);
                }}
                className="app-context-item px-2 py-1 text-xs"
                title="查看会员权益与兑换 Pro"
                role="menuitem"
              >
                <Zap size={13} />
                升级账号
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSettingsSection("system");
                  setSettingsOpen(true);
                }}
                className="app-context-item px-2 py-1 text-xs"
                title="设置（系统 / 账号 / 模型 / 关于）"
                role="menuitem"
              >
                <Settings size={13} />
                设置
                {hasIssue && (
                  <span className="ml-auto flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white">
                    !
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => void logoutCloud()}
                disabled={cloudBusy}
                className="app-context-item is-danger px-2 py-1 text-xs"
                role="menuitem"
              >
                <LogOut size={13} />
                登出
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={openAccountDetail}
                className="app-context-item px-2 py-1.5 text-xs"
                role="menuitem"
              >
                <LogIn size={13} />
                登录 Bowerbird 账号
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSettingsSection("system");
                  setSettingsOpen(true);
                }}
                className="app-context-item px-2 py-1 text-xs"
                title="设置（系统 / 账号 / 模型 / 关于）"
                role="menuitem"
              >
                <Settings size={13} />
                设置
                {hasIssue && (
                  <span className="ml-auto flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white">
                    !
                  </span>
                )}
              </button>
            </>
          )}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => { if (topbar) { setSettingsSection("account"); setSettingsOpen(true); } else setOpen((v) => !v); }}
        className={topbar ? "topbar-account-trigger" : `flex w-full items-center rounded-lg py-2 hover:bg-panel2 ${collapsed ? "justify-center" : "gap-2 px-2"}`}
        title={topbar ? `账号管理 · ${creditsLabel}` : loggedIn ? `${name} · ${tier || "已登录"}` : "未登录"}
        aria-label={topbar ? `${loggedIn ? name : "未登录"}，账号管理，${creditsLabel}` : loggedIn ? `${name}，账号与设置` : "未登录，账号与设置"}
        data-tour="sidebar-account"
        aria-haspopup={topbar ? "dialog" : "menu"}
        aria-expanded={topbar ? settingsOpen : open}
      >
        {topbar && <span className="app-topbar-credits"><Coins size={16} aria-hidden="true"/><span>{creditsText}</span></span>}
        {topbar && !loggedIn && <span className="text-xs text-muted">登录</span>}
        {loggedIn && avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
            {loggedIn ? (name[0] ?? "?").toUpperCase() : "?"}
          </span>
        )}
        {!compact && <><span className="min-w-0 flex-1 truncate text-left text-xs text-ink">
          {loggedIn ? name : "未登录"}
        </span>
        {tier && (
          <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            {tier}
          </span>
        )}
        {open ? <ChevronUp size={13} className="shrink-0 text-muted" /> : <ChevronDown size={13} className="shrink-0 text-muted" />}</>}
      </button>

      {settingsOpen && <SettingsDialog initialSection={settingsSection} onClose={() => { setSettingsOpen(false); triggerRef.current?.focus(); }} />}
    </div>
  );
}
