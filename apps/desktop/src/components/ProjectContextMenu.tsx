import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderSync, Pencil } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { useProjectDeletion } from "./useProjectDeletion";
import { ProjectRenameDialog } from "./ProjectRenameDialog";
import { notifyError, notifySuccess } from "../lib/notify";

const MENU_WIDTH = 232;
const MENU_HEIGHT = 180;

/**
 * 侧栏项目右键菜单：更新项目文件 / 删除项目。
 * 「更新项目文件」重新扫描项目 workspace 文件夹，把应用外手动放进来的新图片导入并加入项目
 * （约定 18：项目不监听文件夹，同步由用户手动触发）。删除项目只删除其唯一画板、内部
 * 线程和本地关系；中央素材与底层执行审计始终保留。
 * 全局单实例（store.projectContextMenu 驱动），挂在 App 最外层；
 * 展开态项目行（ProjectSection）/ 收起态圆标（Sidebar）各自 onContextMenu 触发。
 */
export function ProjectContextMenu() {
  const menu = useStore((s) => s.projectContextMenu);
  const close = useStore((s) => s.closeProjectContextMenu);
  const projects = useStore((s) => s.projects);
  const { busy: deleting, prepareDelete, confirmation } = useProjectDeletion(close);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 每次打开重置菜单状态；删除影响在菜单关闭后仍要保留给确认框。
  useEffect(() => {
    setBusy(false);
  }, [menu]);

  // 菜单打开时：点击菜单外关闭、Esc 关闭（同素材右键菜单）。
  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  async function refresh(projectId: string) {
    setBusy(true);
    try {
      const result = await api.refreshProject(projectId);
      notifySuccess(
        result.added_count > 0
          ? `项目已更新，新增 ${result.added_count} 张素材`
          : "项目已是最新，没有新增素材"
      );
      close();
    } catch (e) {
      notifyError(e, "更新项目文件失败");
      setBusy(false);
    }
  }

  if (!menu) return <>{confirmation}{renaming && <ProjectRenameDialog
    projectId={renaming.id} currentName={renaming.name} onClose={() => setRenaming(null)}
  />}</>;

  // 守卫后捕获，闭包里直接用（TS 不会把守卫的收窄带进嵌套函数）。
  const projectId = menu.projectId;
  const project = projects.find((p) => p.id === projectId);
  const isBuiltin = project?.kind === "builtin";
  // 空白项目没有关联文件夹，因此不提供「更新项目文件」。
  const isBlank = project?.kind === "blank";

  // 菜单定位：固定到鼠标位置，超右/下边缘时收进来。
  const x = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8));
  const y = Math.max(4, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8));

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: "fixed", left: x, top: y, width: MENU_WIDTH, zIndex: 60 }}
      onContextMenu={(e) => e.preventDefault()}
      className="app-context-menu p-1.5 text-xs"
      role="menu"
      aria-label="项目操作"
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy || deleting || !project}
        onClick={() => {
          if (!project) return;
          setRenaming({ id: project.id, name: project.name });
          close();
        }}
        className="app-context-item px-2 py-1.5"
      >
        <Pencil size={13} className="shrink-0" />
        重命名
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => void refresh(projectId)}
        disabled={busy || deleting || isBuiltin || isBlank}
        title={
          isBuiltin || isBlank
            ? "该项目没有关联的本地文件夹"
            : "更新文件夹中的图片素材"
        }
        className="app-context-item px-2 py-1.5"
      >
        <FolderSync size={13} className="shrink-0" />
        {busy ? "更新中…" : "更新项目文件"}
      </button>

      <div className="app-context-divider" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void prepareDelete(projectId);
        }}
        disabled={busy || deleting}
        title="删除项目画板和内部线程；中央素材保留"
        className="app-context-item is-danger px-2 py-1.5"
      >
        删除项目 · 素材保留
      </button>
    </div>,
    document.body
  );
}
