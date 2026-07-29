import { useState } from "react";
import { useStore } from "../store";
import { SettingsDialog } from "./SettingsDialog";

/**
 * 工具栏齿轮按钮（设置入口）：点开看 codex / 浏览器扩展状态 + 新手教程。
 *
 * 取代原先零散的 ExtensionStatus 绿/灰圆点——状态信息整合进设置面板。
 * 右上角角标：codex 或扩展任一未就绪 → 红色「!」；全部健康 → 无角标。
 * （CodexStatus 的生成/反推运行转圈是实时反馈、性质不同，仍在工具栏保留。）
 */
export function SettingsButton() {
  const codexHealth = useStore((s) => s.codexHealth);
  const extensionConnected = useStore((s) => s.extensionConnected);
  const [open, setOpen] = useState(false);

  const hasIssue = !codexHealth?.ok || !extensionConnected;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative rounded-md bg-panel2 px-2 py-1.5 text-sm text-ink hover:bg-edge"
        title="设置（codex / 扩展状态 / 新手教程）"
      >
        <span className="text-base leading-none">⚙</span>
        {hasIssue && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white">
            !
          </span>
        )}
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
