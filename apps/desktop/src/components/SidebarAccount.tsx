import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LogIn, LogOut, Settings, Zap } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { understandReady } from "../lib/entitlement";
import { WEBSITE_URL } from "../lib/constants";
import { SettingsDialog } from "./SettingsDialog";

/**
 * 左边栏底部账号区（chatgpt 式）：头像 + 用户名 + 档位徽章，点击向上展开 inline 菜单。
 * 已登录 → 升级账号（官网）/ 设置 / 登出；未登录 → 登录 Bowerbird 账号 / 设置。
 * 账号详情（账号名 / 积分明细 / 升级）已移入设置面板「账号管理」。
 * 菜单沿 ProviderSelect/RatioSelect 的 inline 面板范式（不发明浮层），展开在账号行上方。
 */
export function SidebarAccount() {
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const logoutCloud = useStore((s) => s.logoutCloud);
  const setAccountOnboardingForceOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const codexHealth = useStore((s) => s.codexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const loggedIn = cloudAuth?.logged_in === true;
  const name = cloudAuth?.email || cloudAuth?.user_id || "";
  const tier = cloudEntitlement?.tier?.toUpperCase() ?? "";
  const hasIssue = !understandReady({ entitlement: cloudEntitlement, codexHealth, cloudAuth }) || !extensionConnected;

  function openAccountDetail() {
    setOpen(false);
    setAccountOnboardingForceOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onMouseDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="mt-2 border-t border-edge px-1 pb-1 pt-2">
      {open && (
        <div className="app-popover mb-1.5 flex flex-col gap-0.5" role="menu" aria-label="账号与设置">
          {loggedIn ? (
            <>
              <div className="px-2 py-1 text-[11px] text-muted">
                {name}
                {tier && <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tier}</span>}
              </div>
              <button
                type="button"
                onClick={() => void openExternal(WEBSITE_URL)}
                className="app-context-item px-2 py-1 text-xs"
                title="打开官网查看订阅方案"
                role="menuitem"
              >
                <Zap size={13} />
                升级账号
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
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
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 hover:bg-panel2"
        title={loggedIn ? `${name} · ${tier || "已登录"}` : "未登录"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
          {loggedIn ? (name[0] ?? "?").toUpperCase() : "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-xs text-ink">
          {loggedIn ? name : "未登录"}
        </span>
        {tier && (
          <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            {tier}
          </span>
        )}
        {open ? <ChevronUp size={13} className="shrink-0 text-muted" /> : <ChevronDown size={13} className="shrink-0 text-muted" />}
      </button>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
