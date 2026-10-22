import { useEffect, useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "./ContextMenu";
import { Copy } from "lucide-react";
import { notifyError, notifySuccess } from "../lib/notify";
import { api } from "../lib/api";
import { useStore } from "../store";

/** jobId is the local diagnostic ID, available even before a provider session starts. */
export function GenerationSessionSurface({ jobId, className, children }: {
  jobId: string | null | undefined;
  className: string;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { setMenu(null); }, [jobId]);

  return <div ref={surfaceRef} className={className} tabIndex={0} aria-label="生成会话详情"
    onContextMenu={event => {
      if (event.defaultPrevented || jobId === undefined || !(event.target instanceof Element)) return;
      // Keep text copying, editor menus and media actions intact.
      if (event.target.closest('button, a, input, textarea, select, [contenteditable], img, video, audio, pre, code, [role="menu"]')
        || window.getSelection()?.toString()) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || jobId === undefined) return;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ x: rect.left + 16, y: rect.top + 16 });
    }}>
    {children}
    {menu && <ContextMenu x={menu.x} y={menu.y} label="生成会话操作" trigger={surfaceRef.current} onClose={() => setMenu(null)}>
      <button type="button" role="menuitem" disabled={!jobId}
        className="app-context-item px-2 py-1.5 focus-visible:outline focus-visible:outline-accent"
        title={jobId || "此历史会话未记录任务 ID"}
        onClick={async () => {
          if (!jobId) return;
          setMenu(null);
          surfaceRef.current?.focus({ preventScroll: true });
          try {
            await navigator.clipboard.writeText(jobId);
            notifySuccess("已复制本次会话 ID");
          } catch {
            notifyError("复制会话 ID 失败，请重试", "复制会话 ID 失败");
          }
        }}>
        <Copy size={13} />{jobId ? "复制本次会话 ID" : "此历史会话未记录任务 ID"}
      </button>
      <button type="button" role="menuitem" disabled={!jobId}
        className="app-context-item px-2 py-1.5 focus-visible:outline focus-visible:outline-accent"
        onClick={async () => {
          if (!jobId) return;
          // Freeze the requested session before awaiting; switching panels cannot change the report.
          const memory = useStore.getState().genJobs[jobId];
          setMenu(null);
          surfaceRef.current?.focus({ preventScroll: true });
          try {
            const report = await api.generationDiagnostics(jobId);
            if (!report.attempts.length && !report.task && !memory) throw new Error("此旧会话没有保存诊断记录");
            await navigator.clipboard.writeText(JSON.stringify({ ...report, memorySnapshot: memory ?? null }, null, 2));
            notifySuccess("已复制本次会话诊断信息");
          } catch (error) {
            notifyError(error, "复制会话诊断信息失败");
          }
        }}><Copy size={13} />复制本次会话诊断信息</button>
    </ContextMenu>}
  </div>;
}
