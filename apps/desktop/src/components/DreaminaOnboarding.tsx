import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { api } from "../lib/api";
import type { DreaminaDeviceFlow } from "../lib/types";
import { ModalShell } from "./ModalShell";

type InstallState = "idle" | "running" | "done" | "error";

/**
 * 即梦 dreamina CLI 配置引导（设置「模型设置」的即梦卡片唤起）。
 *
 * 由设置「模型设置」的即梦卡片经 `dreaminaOnboardingForceOpen` 唤起；「稍后再说」与检测成功均直接关闭。
 * step1「一键安装」→ `dreamina_install`（app 内 reqwest 下载二进制，绕过 curl|bash 在 Windows 的坑；
 *   进度经 `dreamina://setup-progress` 推）；
 * step2「打开终端登录」→ `open_dreamina_login`（真 TTY 必需——dreamina login 非 headless 依赖 isatty，
 *   app 内 spawn 非 TTY 不写 token，见踩坑）；
 * step3 终端授权完成后「重新检测」。
 * 成功后端 emit `dreamina://health-changed` → 自动重检 → ok 则直接关闭。
 */
export function DreaminaOnboarding() {
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const forceOpen = useStore((s) => s.dreaminaOnboardingForceOpen);
  const setForceOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);
  const [checking, setChecking] = useState(false);
  const [installState, setInstallState] = useState<InstallState>("idle");
  const [installReason, setInstallReason] = useState("");
  const [loginOpened, setLoginOpened] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [flow, setFlow] = useState<DreaminaDeviceFlow | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  // 安装进度行（stage=install）；保留最后 50 行避免无限增长。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ stage: string; line: string }>("dreamina://setup-progress", (e) => {
      if (e.payload.stage === "install") {
        setLines((ls) => [...ls.slice(-50), e.payload.line]);
      }
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 安装成功后端 emit `dreamina://health-changed` → 自动重检（ok 则直接关引导）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("dreamina://health-changed", () => void recheck()).then((u) =>
      alive ? (unlisten = u) : u()
    );
    return () => {
      alive = false;
      unlisten?.();
    };
    // recheck 仅用稳定 setter + api，陈旧闭包安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 由设置唤起（forceOpen）；不自动弹。
  if (!forceOpen) return null;

  function dismiss() {
    setForceOpen(false);
  }

  async function recheck() {
    setChecking(true);
    try {
      const h = await api.dreaminaHealth();
      setDreaminaHealth(h);
      if (h.ok) {
        setForceOpen(false);
      }
    } catch {
      setDreaminaHealth({ ok: false, reason: "dreamina 状态检测失败" });
    } finally {
      setChecking(false);
    }
  }

  async function doInstall() {
    if (installState === "running") {
      void api.cancelDreaminaSetup();
      return;
    }
    setInstallState("running");
    setInstallReason("");
    setLines([]);
    try {
      const h = await api.dreaminaInstall();
      if (h.ok) setInstallState("done");
      else {
        setInstallState("error");
        setInstallReason(h.reason);
      }
    } catch (e) {
      const msg = String(e);
      // 取消不算失败，回 idle 让用户可重试。
      setInstallState(msg.includes("已取消") ? "idle" : "error");
      if (!msg.includes("已取消")) setInstallReason(msg);
    }
  }

  // 方案 B（app 内自动登录）：spawn login --headless 拿 device flow 字段 → 自动开浏览器授权页
  // → 用户授权后「我已完成授权」checklogin 补完写 token。不依赖终端/真 TTY。
  async function startLogin() {
    setLoginError("");
    setFlow(null);
    try {
      const f = await api.dreaminaLoginHeadless();
      setFlow(f);
      setLoginOpened(true);
      // 一步化：拿到授权链接自动打开浏览器（shell:allow-open 已授权，CodexOnboarding 同款）。
      void open(f.verification_uri).catch((e) => setLoginError(`打开浏览器失败：${e}`));
    } catch (e) {
      setLoginError(String(e));
    }
  }

  async function finishLogin() {
    if (!flow) return;
    setFinishing(true);
    setLoginError("");
    try {
      const h = await api.dreaminaCheckLogin(flow.device_code);
      setDreaminaHealth(h);
      if (h.ok) {
        setForceOpen(false);
      } else {
        setLoginError(h.reason || "授权未完成，请确认已在浏览器完成授权后重试");
      }
    } catch (e) {
      setLoginError(String(e));
    } finally {
      setFinishing(false);
    }
  }

  const reason = dreaminaHealth?.reason ?? "";
  const notInstalled = !dreaminaHealth?.ok && reason.includes("未检测到");
  const ready = dreaminaHealth?.ok === true;
  // CLI 已装即可登录：本机已装 / 已就绪 / 后端判「已装但未登录」三种都算。
  const installDone =
    installState === "done" || ready || (!!dreaminaHealth && !notInstalled);

  return (
    <ModalShell
      title="配置即梦 dreamina CLI"
      eyebrow="Alternative image provider"
      description="使用即梦会员积分作为备选出图引擎；不配置也不影响 codex 出图和本地功能。"
      width="lg"
      preventClose={checking || finishing}
      onClose={dismiss}
      footer={(
        <>
          <button type="button" onClick={dismiss} disabled={checking || finishing} className="app-modal-button">稍后再说</button>
          <button type="button" onClick={() => void recheck()} disabled={checking || finishing} className="app-modal-button">
            {checking && <span className="app-spinner" aria-hidden="true" />}
            {checking ? "检测中…" : "重新检测"}
          </button>
        </>
      )}
    >
        {/* 当前状态：就绪 → 绿；未就绪 → 红 + 后端 reason。已登录可登出（设置面板的登出入口已随
            「AI 出图引擎」板块删除，登出收敛到这里）。 */}
        {ready ? (
          <div className="app-inline-status is-success flex items-center justify-between gap-2">
            <span>✓ dreamina 已就绪，无需配置，可直接关闭此窗口。</span>
            <button
              onClick={async () => {
                try {
                  await api.dreaminaLogout();
                  await recheck();
                } catch (e) {
                  setLoginError(String(e));
                }
              }}
              disabled={checking}
              className="app-modal-button is-danger shrink-0"
              title="登出即梦账号（dreamina logout）"
            >
              登出即梦账号
            </button>
          </div>
        ) : (
          <div className="app-inline-status is-error">
            当前状态：{reason || "检测中…"}
          </div>
        )}

        <ol className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {/* step 1 一键安装 */}
          <li className="setup-card p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                1
              </span>
              <span className="text-ink">安装 dreamina CLI</span>
              {installDone && <span className="text-xs text-green-400">✓ 已安装</span>}
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void doInstall()}
                disabled={installDone}
                className="app-modal-button is-primary"
              >
                {installState === "running"
                  ? "下载中…（点击取消）"
                  : installDone
                    ? "已安装"
                    : "一键安装 dreamina CLI"}
              </button>
              {installState === "running" && lines.length > 0 && (
                <div className="mt-1.5 truncate text-[11px] text-muted" title={lines[lines.length - 1]}>
                  {lines[lines.length - 1]}
                </div>
              )}
              {installState === "error" && (
                <div className="mt-1.5 text-xs text-red-300">{installReason}</div>
              )}
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              app 自动下载官方二进制，无需打开终端。
            </div>
          </li>

          {/* step 2 自动授权登录 */}
          <li className="setup-card p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                2
              </span>
              <span className="text-ink">登录即梦账号</span>
              {ready && <span className="text-xs text-green-400">✓ 已登录</span>}
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void startLogin()}
                disabled={!installDone || ready || finishing}
                className="app-modal-button is-primary"
              >
                {ready
                  ? "已登录"
                  : loginOpened
                    ? "重新打开授权页面"
                    : "自动打开浏览器授权"}
              </button>
              {flow && (
                <div className="mt-1.5 text-[11px] text-muted">
                  已在浏览器打开授权页。若未自动打开，请访问：
                  <div className="mt-0.5 break-all text-accent">{flow.verification_uri}</div>
                  {flow.user_code && (
                    <div className="mt-1">
                      如需输入授权码：<span className="font-mono text-ink">{flow.user_code}</span>
                    </div>
                  )}
                </div>
              )}
              {loginOpened && !ready && (
                <button
                  onClick={() => void finishLogin()}
                  disabled={!flow || finishing}
                  className="app-modal-button is-primary mt-2"
                >
                  {finishing ? "检测中…" : "我已完成授权，登录"}
                </button>
              )}
              {loginError && (
                <div className="mt-1.5 text-xs text-red-300">{loginError}</div>
              )}
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              点击后自动打开浏览器完成授权，全程无需终端。
            </div>
          </li>

          {/* step 3 检测 */}
          <li className="setup-card p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                3
              </span>
              <span className="text-ink">完成后自动检测</span>
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              授权完成后点「我已完成授权，登录」自动检测，通过即配置完成。
            </div>
          </li>
        </ol>

    </ModalShell>
  );
}
