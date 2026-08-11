import { useState } from "react";
import { useStore } from "../store";
import { SettingsDialog } from "./SettingsDialog";

/**
 * 左边栏底部账号区（chatgpt 式）：头像 + 用户名 + 档位徽章，点击向上展开 inline 菜单。
 * 未登录 → 「登录 Bowerbird 账号」（弹 AccountOnboarding）；
 * 已登录 → 「刷新权益」/「管理账号」（弹 AccountOnboarding 看余额与积分流水）/「登出」。
 * 菜单底部另有「设置」入口（原工具栏齿轮迁入；codex/扩展任一未就绪挂红点）。
 * 菜单沿 ProviderSelect/RatioSelect 的 inline 面板范式（不发明浮层），展开在账号行上方。
 */
export function SidebarAccount() {
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const syncCloudEntitlement = useStore((s) => s.syncCloudEntitlement);
  const logoutCloud = useStore((s) => s.logoutCloud);
  const setAccountOnboardingForceOpen = useStore((s) => s.setAccountOnboardingForceOpen);
  const codexHealth = useStore((s) => s.codexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loggedIn = cloudAuth?.logged_in === true;
  const name = cloudAuth?.email || cloudAuth?.user_id || "";
  const tier = cloudEntitlement?.tier?.toUpperCase() ?? "";
  const hasIssue = !codexHealth?.ok || !extensionConnected;

  function openAccountDetail() {
    setOpen(false);
    setAccountOnboardingForceOpen(true);
  }

  return (
    <div className="mt-2 border-t border-edge pt-2">
      {open && (
        <div className="mb-1.5 flex flex-col gap-1 rounded bg-panel2 p-1.5">
          {loggedIn ? (
            <>
              <div className="px-2 py-1 text-[11px] text-muted">
                {name}
                {tier && <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tier}</span>}
              </div>
              <button
                onClick={() => void syncCloudEntitlement()}
                disabled={cloudBusy}
                className="rounded px-2 py-1 text-left text-xs text-ink hover:bg-panel disabled:opacity-50"
              >
                刷新权益
              </button>
              <button
                onClick={openAccountDetail}
                className="rounded px-2 py-1 text-left text-xs text-ink hover:bg-panel"
              >
                管理账号
              </button>
              <button
                onClick={() => void logoutCloud()}
                disabled={cloudBusy}
                className="rounded px-2 py-1 text-left text-xs text-ink hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50"
              >
                登出
              </button>
            </>
          ) : (
            <button
              onClick={openAccountDetail}
              className="rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-panel"
            >
              登录 Bowerbird 账号
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-ink hover:bg-panel"
            title="设置（环境状态 / 素材库位置 / 入库自动反推）"
          >
            <span className="text-sm leading-none">⚙</span>
            设置
            {hasIssue && (
              <span className="ml-auto flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white">
                !
              </span>
            )}
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-panel2"
        title={loggedIn ? `${name} · ${tier || "已登录"}` : "未登录"}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-black">
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
        <span className="shrink-0 text-[10px] text-muted">{open ? "▴" : "▾"}</span>
      </button>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
