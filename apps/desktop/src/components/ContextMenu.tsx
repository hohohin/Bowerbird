import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/**
 * 右键菜单（项目首个 context menu —— 与约定 13 全屏遮罩 Modal 不同的浮层形态：
 * 定位在鼠标坐标的小浮层，非居中卡片）。createPortal 到 document.body，
 * 避免被瀑布流 overflow / columns 容器裁剪。
 *
 * 关闭：点菜单项（执行后）/ 点透明遮罩任意处 / 再次右键 / Esc。
 * 注意：透明遮罩覆盖整屏，故「右键别处」先关闭当前菜单（再右键一次才打开新的），
 * 与系统原生右键菜单的「一次右键关旧开新」略有差异，是 web context menu 的常规取舍。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 边界检测：菜单挂载后测自身尺寸，超出视口右/下沿时翻转到不溢出的位置（paint 前同步完成，无闪烁）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 4;
    setPos({
      x: Math.min(x, window.innerWidth - el.offsetWidth - pad),
      y: Math.min(y, window.innerHeight - el.offsetHeight - pad),
    });
  }, [x, y]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    // 透明遮罩：捕获外部点击与再次右键（preventDefault 抑制浏览器原生菜单），均关闭。
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        // 阻止菜单本体的 mousedown 冒泡到遮罩，否则点菜单项瞬间就被关掉了。
        onMouseDown={(e) => e.stopPropagation()}
        style={{ left: pos.x, top: pos.y }}
        className="fixed min-w-[180px] overflow-hidden rounded-md border border-edge bg-panel py-1 shadow-xl"
      >
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              onClose();
            }}
            className={`flex w-full items-center px-3 py-1.5 text-left text-sm transition disabled:opacity-40 ${
              it.danger ? "text-red-400 hover:bg-red-500/15" : "text-ink hover:bg-panel2"
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
