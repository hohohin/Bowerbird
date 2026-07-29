import { useStore } from "../store";

/**
 * 设置面板（约定 13 全屏 Modal 形态）：codex 状态 + 浏览器扩展状态 + 新手教程入口。
 * 由工具栏齿轮按钮唤起。点背景 / ✕ 关闭。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const codexHealth = useStore((s) => s.codexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const setExtOnboardingForce = useStore((s) => s.setExtensionOnboardingForceOpen);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-edge bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-ink">设置</h2>

        <div className="mt-4 space-y-3 text-sm">
          {/* codex 状态 */}
          <div className="flex items-center justify-between rounded bg-panel2 px-3 py-2">
            <span className="text-ink">codex CLI</span>
            <span className={codexHealth?.ok ? "text-green-400" : "text-red-400"}>
              {codexHealth?.ok
                ? "✓ 就绪"
                : `✗ ${codexHealth?.reason || "未就绪"}`}
            </span>
          </div>

          {/* 浏览器扩展状态 */}
          <div className="flex items-center justify-between rounded bg-panel2 px-3 py-2">
            <span className="text-ink">浏览器扩展</span>
            <span className={extensionConnected ? "text-green-400" : "text-red-400"}>
              {extensionConnected ? "✓ 已连接" : "✗ 未连接"}
            </span>
          </div>
          {!extensionConnected && (
            <button
              onClick={() => {
                setExtOnboardingForce(true);
                onClose();
              }}
              className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90"
            >
              查看扩展安装引导
            </button>
          )}

          {/* 新手教程（占位，后续替换为视频/图片） */}
          <div className="rounded bg-panel2 px-3 py-2">
            <div className="text-ink">新手教程</div>
            <div className="mt-1.5 flex h-20 items-center justify-center rounded border border-dashed border-edge text-[11px] text-muted">
              📷 教程视频 / 图片（待补充）
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-panel2 px-3 py-1.5 text-sm text-ink hover:bg-edge"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
