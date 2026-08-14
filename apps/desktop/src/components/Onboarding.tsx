import { useStore } from "../store";
import { ModalShell } from "./ModalShell";

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
    <div className="setup-card flex min-h-40 flex-col gap-2 p-4">
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
        className={`app-modal-button mt-auto w-full ${ok === false || ok === undefined ? "is-primary" : ""}`}
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
 * 不首启自动弹（阶段 B 起 tour 接管引导）；仅 Toolbar「环境状态」手动唤起（forceOpen）。
 */
export function Onboarding() {
  const codexHealth = useStore((s) => s.codexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const dreaminaHealth = useStore((s) => s.dreaminaHealth);
  const forceOpen = useStore((s) => s.onboardingForceOpen);
  const setForceOpen = useStore((s) => s.setOnboardingForceOpen);
  const codexOpen = useStore((s) => s.codexOnboardingForceOpen);
  const extensionOpen = useStore((s) => s.extensionOnboardingForceOpen);
  const dreaminaOpen = useStore((s) => s.dreaminaOnboardingForceOpen);
  const setCodexOpen = useStore((s) => s.setCodexOnboardingForceOpen);
  const setExtensionOpen = useStore((s) => s.setExtensionOnboardingForceOpen);
  const setDreaminaOpen = useStore((s) => s.setDreaminaOnboardingForceOpen);

  // 任一二級打开时一级不渲染，避免自动显示场景下产生双层 Modal。
  if (codexOpen || extensionOpen || dreaminaOpen) return null;

  // 不再首启自动弹（tour 接管引导）；仅在 forceOpen（Toolbar「环境状态」手动唤起）时渲染。
  if (!forceOpen) return null;

  function dismiss() {
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

  return (
    <ModalShell
      title="开始使用 Bowerbird"
      eyebrow="Environment setup"
      description="配置好以下环境后，反推、生成、采集即可使用。点「前往配置」查看详细引导。"
      width="lg"
      onClose={dismiss}
      footer={<button type="button" onClick={dismiss} className="app-modal-button">稍后再说</button>}
    >
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
              title="即梦 CLI"
              subtitle="dreamina · 备选出图"
              ok={dreaminaHealth?.ok}
              reason={dreaminaHealth?.ok ? undefined : dreaminaHealth?.reason}
              actionLabel={dreaminaHealth?.ok ? "查看引导" : "前往配置"}
              onAction={goDreamina}
            />
            <Card
              n={4}
              title="新手教程"
              subtitle="分步引导走一遍核心流程"
              actionLabel="开始引导"
              onAction={() => {
                useStore.getState().startTour();
                setForceOpen(false);
              }}
            />
          </div>
    </ModalShell>
  );
}
