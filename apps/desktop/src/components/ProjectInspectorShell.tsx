import { useEffect, useRef, type ReactNode } from "react";
import { Images, Sparkles, X } from "lucide-react";
import type { ProjectInspectorHeader } from "../lib/projectInspector";

export function ProjectInspectorShell({
  header,
  anchorNodeId,
  restoreFocusTarget,
  editing = false,
  composing = false,
  onClose,
  children,
}: {
  header: ProjectInspectorHeader;
  anchorNodeId?: string | null;
  restoreFocusTarget?: () => HTMLElement | null;
  editing?: boolean;
  composing?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closedByOutsideClickRef = useRef(false);
  const restoreFocusTargetRef = useRef(restoreFocusTarget);
  restoreFocusTargetRef.current = restoreFocusTarget;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shellRef.current?.focus({ preventScroll: true });
    return () => {
      if (closedByOutsideClickRef.current) return;
      const previous = previousFocusRef.current;
      const target = previous?.isConnected ? previous : restoreFocusTargetRef.current?.();
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    };
  }, []);

  useEffect(() => {
    closedByOutsideClickRef.current = false;
    if (editing || composing) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (shellRef.current?.contains(event.target)) return;
      // 面板内打开的预览、弹窗和菜单可能通过 portal 挂在 body 下。
      if (event.target.closest('[role="dialog"], [role="menu"], [role="listbox"], .task-center-entry')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      closedByOutsideClickRef.current = true;
      onClose();
    }
    // 使用 click 而非 pointerdown，避免收起后布局变化影响本次点击目标。
    document.addEventListener("click", closeOnOutsideClick, true);
    return () => document.removeEventListener("click", closeOnOutsideClick, true);
  }, [editing, composing, onClose, anchorNodeId]);

  return (
    <section
      ref={shellRef}
      tabIndex={-1}
      role="complementary"
      aria-label={`${header.title} · 项目详情`}
      data-project-inspector={header.kind}
      data-anchor-node-id={anchorNodeId ?? undefined}
      className={`project-inspector-shell${editing ? " is-editing" : ""}`}
    >
      <div className={`shrink-0 ${editing ? "gen-view-out pointer-events-none" : "gen-view-in"}`}>
        <div className={`${editing ? "" : "pointer-events-auto"} project-inspector-header`}>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            {header.kind === "generation" ? <Images size={14} /> : <Sparkles size={14} />}
          </span>
          <strong className="min-w-0 flex-1 truncate text-xs font-semibold" title={header.title}>
            {header.title}
          </strong>
          <span className="project-inspector-detail max-w-[48%] shrink truncate rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted" title={header.detail}>
            {header.detail}
          </span>
          {header.running && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {header.kind === "generation" ? "生成中" : "运行中"}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="app-icon-button ml-auto"
            title="关闭详情（进行中的任务不会中断）"
            aria-label={header.closeLabel}
          >
            <X size={16} />
          </button>
        </div>
        <div className="hatch-divider" aria-hidden="true"><span /></div>
      </div>
      {children}
    </section>
  );
}
