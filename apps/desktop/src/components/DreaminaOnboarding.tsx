import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { api } from "../lib/api";

type InstallState = "idle" | "running" | "done" | "error";

/**
 * 即梦 dreamina CLI 配置引导（一级「环境状态」总览的二级弹窗）。
 *
 * 只由一级总览卡片经 `dreaminaOnboardingForceOpen` 跳转唤起；「稍后再说」与检测成功均返回一级。
 * step1「一键安装」→ `dreamina_install`（app 内 reqwest 下载二进制，绕过 curl|bash 在 Windows 的坑；
 *   进度经 `dreamina://setup-progress` 推）；
 * step2「打开终端登录」→ `open_dreamina_login`（真 TTY 必需——dreamina login 非 headless 依赖 isatty，
 *   app 内 spawn 非 TTY 不写 token，见踩坑）；
 * step3 终端授权完成后「重新检测」。
 * 成功后端 emit `dreamina://health-changed` → 自动重检 → ok 则回一级。
 */
export function DreaminaOnboarding() {
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const forceOpen = useStore((s) => s.dreaminaOnboardingForceOpen);
  const setForceOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);
  const setOverviewOpen = useStore((s) => s.setOnboardingForceOpen);
  const [checking, setChecking] = useState(false);
  const [installState, setInstallState] = useState<InstallState>("idle");
  const [installReason, setInstallReason] = useState("");
  const [loginOpened, setLoginOpened] = useState(false);
  const [loginError, setLoginError] = useState("");
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

  // 安装成功后端 emit `dreamina://health-changed` → 自动重检（ok 则回一级）。
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

  // 只由一级总览卡片跳转唤起（forceOpen）；不自动弹。
  if (!forceOpen) return null;

  function dismiss() {
    setForceOpen(false);
    setOverviewOpen(true);
  }

  async function recheck() {
    setChecking(true);
    try {
      const h = await api.dreaminaHealth();
      setDreaminaHealth(h);
      if (h.ok) {
        setForceOpen(false);
        setOverviewOpen(true);
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

  async function openLogin() {
    setLoginError("");
    try {
      await api.openDreaminaLogin();
      setLoginOpened(true);
    } catch (e) {
      setLoginError(String(e));
    }
  }

  const reason = dreaminaHealth?.reason ?? "";
  const notInstalled = !dreaminaHealth?.ok && reason.includes("未检测到");
  const ready = dreaminaHealth?.ok === true;
  // CLI 已装即可登录：本机已装 / 已就绪 / 后端判「已装但未登录」三种都算。
  const installDone =
    installState === "done" || ready || (!!dreaminaHealth && !notInstalled);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-edge bg-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-ink">
          配置即梦 dreamina CLI（备选出图引擎）
        </h2>
        <p className="mt-1.5 text-sm text-muted">
          即梦是国内图像生成模型，作为 codex 的备选出图 provider（消耗你的即梦会员积分）。配置后可在创作板切换使用。不配置也能正常使用 codex 出图与所有本地功能。
        </p>

        {/* 当前状态：就绪 → 绿；未就绪 → 红 + 后端 reason。 */}
        {ready ? (
          <div className="mt-4 rounded bg-green-500/15 p-2 text-xs text-green-400">
            ✓ dreamina 已就绪，无需配置，可直接关闭此窗口。
          </div>
        ) : (
          <div className="mt-4 rounded bg-red-500/15 p-2 text-xs text-red-300">
            当前状态：{reason || "检测中…"}
          </div>
        )}

        <ol className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {/* step 1 一键安装 */}
          <li className="text-sm">
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
                className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90 disabled:opacity-50"
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

          {/* step 2 打开终端登录 */}
          <li className="text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                2
              </span>
              <span className="text-ink">登录即梦账号</span>
              {ready && <span className="text-xs text-green-400">✓ 已登录</span>}
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void openLogin()}
                disabled={!installDone || ready}
                className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90 disabled:opacity-50"
              >
                {ready ? "已登录" : loginOpened ? "再开一次终端" : "打开终端登录"}
              </button>
              {loginError && (
                <div className="mt-1.5 text-xs text-red-300">{loginError}</div>
              )}
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              会打开系统终端，按提示扫码 / 浏览器授权（dreamina 登录依赖终端环境，无法在 app 内完成）。
            </div>
          </li>

          {/* step 3 重新检测 */}
          <li className="text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                3
              </span>
              <span className="text-ink">终端授权后重新检测</span>
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              在终端完成授权后回这里点「重新检测」，通过即配置完成。
            </div>
          </li>
        </ol>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={dismiss}
            className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge"
          >
            稍后再说
          </button>
          <button
            onClick={() => void recheck()}
            disabled={checking}
            className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge disabled:opacity-50"
          >
            {checking ? "检测中…" : "重新检测"}
          </button>
        </div>
      </div>
    </div>
  );
}
