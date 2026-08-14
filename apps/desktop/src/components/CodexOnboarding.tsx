import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ModalShell } from "./ModalShell";

const NODE_SITE = "https://nodejs.org";

type StepState = "idle" | "running" | "done" | "error";

/**
 * codex 配置引导（一级「环境状态」总览的二级弹窗；约定 7 离线/无账号降级的入口）。
 *
 * 不再自行判断 seen、不自动弹——只由一级总览卡片经 `codexOnboardingForceOpen` 跳转唤起；
 * 「稍后再说」与检测成功均返回一级总览，由一级负责最终关闭与写 seen。
 *
 * step1「一键安装」→ `codex_install`（spawn npm，进度经 `codex://setup-progress` 推）；
 * step2「一键登录」→ `codex_login`（spawn codex login，codex 自己开浏览器 OAuth）。
 * 成功后端 emit `codex://health-changed` → 自动重检 → ok 则回一级。
 */
export function CodexOnboarding() {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const forceOpen = useStore((s) => s.codexOnboardingForceOpen);
  const setForceOpen = useStore((s) => s.setCodexOnboardingForceOpen);
  // 点「稍后再说」/检测成功回一级总览（而非直接关回主界面）。
  const setOverviewOpen = useStore((s) => s.setOnboardingForceOpen);
  const [checking, setChecking] = useState(false);

  const [installState, setInstallState] = useState<StepState>("idle");
  const [installReason, setInstallReason] = useState("");
  const [loginState, setLoginState] = useState<StepState>("idle");
  const [loginReason, setLoginReason] = useState("");
  const [lines, setLines] = useState<string[]>([]);

  // 安装进度行（stage=install）；保留最后 50 行避免无限增长。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ stage: string; line: string }>("codex://setup-progress", (e) => {
      if (e.payload.stage === "install") {
        setLines((ls) => [...ls.slice(-50), e.payload.line]);
      }
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 安装/登录成功后端 emit `codex://health-changed` → 自动重检（ok 则回一级）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("codex://health-changed", () => void recheck()).then((u) =>
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
      const h = await api.codexHealth();
      setCodexHealth(h);
      // 检测通过：关二级 + 回一级总览（一级只能由用户关闭，不在此处自动收）。
      if (h.ok) {
        setForceOpen(false);
        setOverviewOpen(true);
      }
    } catch {
      setCodexHealth({ ok: false, reason: "codex 状态检测失败" });
    } finally {
      setChecking(false);
    }
  }

  async function doInstall() {
    if (installState === "running") {
      void api.cancelCodexSetup();
      return;
    }
    setInstallState("running");
    setInstallReason("");
    setLines([]);
    try {
      const h = await api.codexInstall();
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

  async function doLogin() {
    if (loginState === "running") {
      void api.cancelCodexSetup();
      return;
    }
    setLoginState("running");
    setLoginReason("");
    try {
      const h = await api.codexLogin();
      if (h.ok) setLoginState("done");
      else {
        setLoginState("error");
        setLoginReason(h.reason);
      }
    } catch (e) {
      const msg = String(e);
      setLoginState(msg.includes("已取消") ? "idle" : "error");
      if (!msg.includes("已取消")) setLoginReason(msg);
    }
  }

  // CLI 已装即可登录：本地装过 / 已就绪 / 后端判「已装但未登录」三种都算。
  const installDone =
    installState === "done" ||
    codexHealth?.ok === true ||
    codexHealth?.reason.includes("未登录") === true;
  const loginDone = loginState === "done" || codexHealth?.ok === true;
  const needNode =
    installState === "error" && installReason.includes("Node");

  return (
    <ModalShell
      title="配置 codex CLI（可选）"
      eyebrow="Local AI setup"
      description="使用 ChatGPT 订阅进行反推、生成和命名，仅 Pro / Studio 可用；不配置也不影响本地素材库。"
      width="lg"
      preventClose={checking}
      onClose={dismiss}
      footer={(
        <>
          <button type="button" onClick={dismiss} disabled={checking} className="app-modal-button">稍后再说</button>
          <button type="button" onClick={() => void recheck()} disabled={checking} className="app-modal-button">
            {checking && <span className="app-spinner" aria-hidden="true" />}
            {checking ? "检测中…" : "重新检测"}
          </button>
        </>
      )}
    >
        {/* 当前状态：就绪 → 绿（提示可直接关闭）；未就绪 → 红 + 后端 reason。 */}
        {codexHealth?.ok ? (
          <div className="app-inline-status is-success">
            ✓ codex 已就绪，无需配置，可直接关闭此窗口。
          </div>
        ) : (
          <div className="app-inline-status is-error">
            当前状态：{codexHealth?.reason ?? "检测中…"}
          </div>
        )}

        <ol className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {/* step 1 一键安装 */}
          <li className="setup-card p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                1
              </span>
              <span className="text-ink">安装 codex CLI</span>
              {installDone && <span className="text-xs text-green-400">✓ 已安装</span>}
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void doInstall()}
                disabled={installDone}
                className="app-modal-button is-primary"
              >
                {installState === "running"
                  ? "安装中…（点击取消）"
                  : installDone
                    ? "已安装"
                    : "一键安装 codex CLI"}
              </button>
              {installState === "running" && lines.length > 0 && (
                <pre className="mt-1.5 max-h-28 overflow-auto rounded bg-panel2 p-2 text-[11px] text-muted">
                  {lines.join("\n")}
                </pre>
              )}
              {installState === "error" && (
                <div className="mt-1.5 text-xs text-red-300">
                  {installReason}
                  {needNode && (
                    <button type="button"
                      onClick={() => void open(NODE_SITE)}
                      className="app-modal-button ml-2 min-h-7 px-2"
                    >
                      打开 Node 官网
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              app 自动执行 npm install，无需打开终端。
            </div>
          </li>

          {/* step 2 一键登录 */}
          <li className="setup-card p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                2
              </span>
              <span className="text-ink">登录 ChatGPT 订阅</span>
              {loginDone && <span className="text-xs text-green-400">✓ 已登录</span>}
            </div>
            <div className="mt-1.5 pl-7">
              <button
                onClick={() => void doLogin()}
                disabled={!installDone || loginDone}
                className="app-modal-button is-primary"
              >
                {loginState === "running"
                  ? "等待浏览器登录…（点击取消）"
                  : loginDone
                    ? "已登录"
                    : "一键登录 ChatGPT"}
              </button>
              {loginState === "error" && (
                <div className="mt-1.5 text-xs text-red-300">{loginReason}</div>
              )}
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              点击后会打开浏览器，用你的 ChatGPT 账号授权（需 Plus / Pro 等订阅）。
            </div>
          </li>

          {/* step 3 自动检测 */}
          <li className="setup-card p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
                3
              </span>
              <span className="text-ink">完成后自动检测</span>
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              登录成功后会自动检测并返回环境状态总览；也可手动重新检测。
            </div>
          </li>
        </ol>

    </ModalShell>
  );
}
