import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ModalShell } from "./ModalShell";

type StepState = "idle" | "running" | "done" | "error";

/**
 * codex 配置引导（由设置「模型设置」的 codex 卡片唤起；约定 7 离线/无账号降级的入口）。
 *
 * 不再自行判断 seen、不自动弹——只由设置「模型设置」经 `codexOnboardingForceOpen` 唤起；
 * 「稍后再说」与检测成功均直接关闭。
 *
 * step1「一键安装」→ `codex_install`（后端免 Node 直装独立版：下载官方平台包 tarball
 * + sha512 校验 + 解压到应用数据目录，进度经 `codex://setup-progress` 推，含 percent；
 * 失败且本机有 npm 时自动回退 npm 安装）；
 * step2「一键登录」→ `codex_login`（spawn codex login，codex 自己开浏览器 OAuth）。
 * 成功后端 emit `codex://health-changed` → 自动重检 → ok 则直接关闭。
 */
export function CodexOnboarding() {
  const codexHealth = useStore((s) => s.codexHealth);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const forceOpen = useStore((s) => s.codexOnboardingForceOpen);
  const setForceOpen = useStore((s) => s.setCodexOnboardingForceOpen);
  const [checking, setChecking] = useState(false);

  const [installState, setInstallState] = useState<StepState>("idle");
  const [installReason, setInstallReason] = useState("");
  const [loginState, setLoginState] = useState<StepState>("idle");
  const [loginReason, setLoginReason] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [percent, setPercent] = useState<number | null>(null);

  // 安装进度行（stage=install，直装下载带 percent）；保留最后 50 行避免无限增长。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ stage: string; line: string; percent?: number | null }>("codex://setup-progress", (e) => {
      if (e.payload.stage === "install") {
        setLines((ls) => [...ls.slice(-50), e.payload.line]);
        setPercent(typeof e.payload.percent === "number" ? e.payload.percent : null);
      }
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 安装/登录成功后端 emit `codex://health-changed` → 自动重检（ok 则直接关引导）。
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

  // 由设置唤起（forceOpen）；不自动弹。
  if (!forceOpen) return null;

  function dismiss() {
    setForceOpen(false);
  }

  async function recheck() {
    setChecking(true);
    try {
      const h = await api.codexHealth();
      setCodexHealth(h);
      // 检测通过：直接关引导。
      if (h.ok) {
        setForceOpen(false);
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
    setPercent(null);
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
              {installState === "running" && percent !== null && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-panel2">
                  <div
                    className="h-full rounded bg-accent transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                  />
                </div>
              )}
              {installState === "running" && lines.length > 0 && (
                <pre className="mt-1.5 max-h-28 overflow-auto rounded bg-panel2 p-2 text-[11px] text-muted">
                  {lines.join("\n")}
                </pre>
              )}
              {installState === "error" && (
                <div className="mt-1.5 text-xs text-red-300">{installReason}</div>
              )}
            </div>
            <div className="mt-1 pl-7 text-xs text-muted">
              自动下载官方独立版 codex（约 130MB，无需 Node.js，也不打开终端）。
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
