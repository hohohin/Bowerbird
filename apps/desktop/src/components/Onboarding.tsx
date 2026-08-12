import { useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { understandReady } from "../lib/entitlement";

const SEEN_KEY = "bowerbird.onboardingSeen";

function StatusBadge({ ok }: { ok?: boolean; reason?: string }) {
  if (ok === true)
    return (
      <span className="rounded bg-green-500/15 px-2 py-0.5 text-xs text-green-400">✓ 就绪</span>
    );
  if (ok === false)
    // 四列卡片空间有限，不展开长 reason（如 dreamina 的「运行 curl … 安装」），
    // 只显「未就绪」；详细原因在二级引导（Codex/Dreamina/Extension Onboarding）里看。
    return (
      <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-300">✗ 未就绪</span>
    );
  return <span className="rounded bg-panel2 px-2 py-0.5 text-xs text-muted">—</span>;
}

function Card({
  n,
  title,
  subtitle,
  ok,
  reason,
  actionLabel,
  onAction,
  disabled,
}: {
  n: number;
  title: string;
  subtitle: string;
  ok?: boolean;
  reason?: string;
  actionLabel: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-edge bg-panel2/40 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">
          {n}
        </span>
        <span className="flex-1 text-sm font-medium text-ink">{title}</span>
        <StatusBadge ok={ok} reason={reason} />
      </div>
      <span className="text-xs text-muted">{subtitle}</span>
      <button
        onClick={onAction}
        disabled={disabled}
        className="mt-auto rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-black hover:opacity-90 disabled:opacity-50"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/**
 * 统一「环境状态」总览（合并原 codex / 扩展两个自动弹的 onboarding）。
 * 三卡片并排：codex CLI / 浏览器扩展 / 即梦 dreamina CLI。点「前往配置」跳转到对应的详细 onboarding
 * 子弹窗（CodexOnboarding / ExtensionOnboarding / DreaminaOnboarding，forceOpen 唤起，不再各自自动弹）。
 * Bowerbird 账号不在此列——它是独立的账号面板（侧栏底部账号区唤起），与「环境状态」无关。
 * 首启：codex/扩展任一未就绪 + 未 seen 自动弹这一个总览；设置「环境状态」可手动唤起。
 */
export function Onboarding() {
  const codexHealth = useStore((s) => s.codexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const forceOpen = useStore((s) => s.onboardingForceOpen);
  const setForceOpen = useStore((s) => s.setOnboardingForceOpen);
  const codexOpen = useStore((s) => s.codexOnboardingForceOpen);
  const extensionOpen = useStore((s) => s.extensionOnboardingForceOpen);
  const dreaminaOpen = useStore((s) => s.dreaminaOnboardingForceOpen);
  const setCodexOpen = useStore((s) => s.setCodexOnboardingForceOpen);
  const setExtensionOpen = useStore((s) => s.setExtensionOnboardingForceOpen);
  const setDreaminaOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);
  const [seen, setSeen] = useState(() => localStorage.getItem(SEEN_KEY) === "1");

  // 任一二級打开时一级不渲染，避免自动显示场景下产生双层 Modal。
  if (codexOpen || extensionOpen || dreaminaOpen) return null;

  // 一级只能由用户关闭（✕ / 「稍后再说」）：不因 codex/扩展状态变化自动收。
  // seen 仅在用户主动 dismiss 时写入，用于「首启未配齐才自动弹一次，用户看过就不再骚扰」。
  // 理解引擎就绪按权益路由判断（Pro→codex、免费→Cloud），不再直判 codexHealth：
  // 否则免费档登录 Cloud 后这里仍误报「未就绪」、首启反复弹总览。
  const hasIssue = !understandReady({ entitlement: cloudEntitlement, codexHealth, cloudAuth }) || !extensionConnected;
  if (!forceOpen && (seen || !hasIssue)) return null;

  function dismiss() {
    localStorage.setItem(SEEN_KEY, "1");
    setSeen(true);
    setForceOpen(false);
  }
  // 跳转到详细子 onboarding：关总览 + 弹子。
  function goCodex() {
    setForceOpen(false);
    setCodexOpen(true);
  }
  function goExtension() {
    setForceOpen(false);
    setExtensionOpen(true);
  }
  function goDreamina() {
    setForceOpen(false);
    setDreaminaOpen(true);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="环境状态"
    >
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-lg border border-edge bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-edge p-5">
          <div>
            <h2 className="text-lg font-semibold text-ink">环境状态</h2>
            <p className="mt-0.5 text-xs text-muted">
              配置好以下环境后，反推、生成、采集即可使用。点「前往配置」查看详细引导。
            </p>
          </div>
          <button
            onClick={dismiss}
            className="rounded-md bg-panel2 px-2 py-1 text-sm text-muted hover:text-ink"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Card
              n={1}
              title="codex CLI"
              subtitle="反推 / 生成 / 命名"
              ok={codexHealth?.ok}
              reason={codexHealth?.reason}
              actionLabel={codexHealth?.ok ? "查看引导" : "前往配置"}
              onAction={goCodex}
            />
            <Card
              n={2}
              title="浏览器扩展"
              subtitle="网页采集"
              ok={extensionConnected}
              reason={extensionConnected ? undefined : "未连接"}
              actionLabel={extensionConnected ? "查看引导" : "前往配置"}
              onAction={goExtension}
            />
            <Card
              n={3}
              title="即梦 dreamina CLI"
              subtitle="备选出图引擎"
              ok={dreaminaHealth?.ok}
              reason={dreaminaHealth?.ok ? undefined : dreaminaHealth?.reason}
              actionLabel={dreaminaHealth?.ok ? "查看引导" : "前往配置"}
              onAction={goDreamina}
            />
            <Card
              n={4}
              title="新手教程"
              subtitle="视频引导（待补充）"
              actionLabel="即将推出"
              disabled
            />
          </div>
        </div>

        <footer className="flex justify-end border-t border-edge p-5">
          <button
            onClick={dismiss}
            className="rounded-md bg-panel2 px-4 py-1.5 text-sm text-ink hover:bg-edge"
          >
            稍后再说
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
