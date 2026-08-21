import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderSync } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { notifyError, notifySuccess } from "../lib/notify";
import type { ProjectDeleteMode, ProjectDeleteResult } from "../lib/types";

const MENU_WIDTH = 232;
// 全量项（更新文件 + 删除组三模式 + 标签与分隔线）估算高度，用于视口边缘钳制。
const MENU_HEIGHT = 240;

function deleteResultMessage(mode: ProjectDeleteMode, result: ProjectDeleteResult): string {
  if (mode === "keep") {
    return "项目已删除，素材仍保留在全局";
  }
  if (mode === "move_out") {
    return (
      `已移出 ${result.moved_assets} 张素材回 workspace，保留 ${result.preserved_shared} 张共享素材` +
      (result.failed_moves.length > 0
        ? `；${result.failed_moves.length} 张移出失败已保留在全局`
        : "")
    );
  }
  return `已物理删除 ${result.deleted_assets} 张独占素材，保留 ${result.preserved_shared} 张共享素材`;
}

/**
 * 侧栏项目右键菜单：更新项目文件 / 删除项目。
 * 「更新项目文件」重新扫描项目 workspace 文件夹，把应用外手动放进来的新图片导入并加入项目
 * （约定 18：项目不监听文件夹，同步由用户手动触发）；「删除项目」三模式与旧侧栏行内删除
 * 面板语义一致（keep / move_out / delete_exclusive），物理删除仍过确认弹窗。
 * 全局单实例（store.projectContextMenu 驱动），挂在 App 最外层；
 * 展开态项目行（ProjectSection）/ 收起态圆标（Sidebar）各自 onContextMenu 触发。
 */
export function ProjectContextMenu() {
  const menu = useStore((s) => s.projectContextMenu);
  const close = useStore((s) => s.closeProjectContextMenu);
  const projects = useStore((s) => s.projects);
  const exitProject = useStore((s) => s.exitProject);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 每次打开重置子状态。（pendingDeleteId 不在此重置——点「物理删除独占素材」会先 close
  // 收菜单再弹 dialog，menu=null 触发本 effect，重置会把尚需显示的 dialog 一起清掉。）
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

  async function remove(projectId: string, mode: ProjectDeleteMode) {
    setBusy(true);
    try {
      const result = await api.deleteProject(projectId, mode);
      // 删的是当前项目 → 退回全局，否则 active scope 悬空导致列表空白。
      if (useStore.getState().currentProjectId === projectId) await exitProject();
      await reloadProjects();
      notifySuccess(deleteResultMessage(mode, result));
      close();
    } catch (e) {
      notifyError(e, "删除项目失败");
      setBusy(false);
    }
  }

  // 物理删除确认 dialog：独立于菜单渲染。点「物理删除独占素材」会先 closeContextMenu 收菜单，
  // menu=null 走此分支单独挂载。
  if (!menu) {
    return (
      <ConfirmDialog
        open={pendingDeleteId !== null}
        danger
        title="物理删除独占素材"
        message={
          <>项目的独占素材将从全局及所有项目物理删除，<strong>不可恢复</strong>；共享素材保留。</>
        }
        confirmLabel="物理删除"
        onConfirm={() => {
          const id = pendingDeleteId;
          setPendingDeleteId(null);
          if (id) void remove(id, "delete_exclusive");
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    );
  }

  // 守卫后捕获，闭包里直接用（TS 不会把守卫的收窄带进嵌套函数）。
  const projectId = menu.projectId;
  const project = projects.find((p) => p.id === projectId);
  const isBuiltin = project?.kind === "builtin";
  // 空白项目（菜单「新建空白项目」）：无关联文件夹，「更新文件」无意义、「移出」没有
  // workspace 可回（后端也降级 Keep），但「物理删除独占素材」照常可用。
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
        onClick={() => void refresh(projectId)}
        disabled={busy || isBuiltin || isBlank}
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
      <div className="app-context-label">删除项目</div>
      <button
        type="button"
        role="menuitem"
        onClick={() => void remove(projectId, "keep")}
        disabled={busy}
        title="只删除项目关系，素材全部留在全局"
        className="app-context-item px-2 py-1.5"
      >
        仅删除项目 · 素材留在全局
      </button>
      {/* 内置项目（如欢迎项目）后端强制 Keep 语义：移出/物理删除对它无意义，不显示；
          空白项目无 workspace 可移回，「移出」不显示（「物理删除独占素材」保留）。 */}
      {!isBuiltin && (
        <>
          {!isBlank && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void remove(projectId, "move_out")}
              disabled={busy}
              title="删除项目并将独占素材文件移回 workspace 文件夹；共享素材保留在全局"
              className="app-context-item px-2 py-1.5"
            >
              移出园丁鸟 · 独占素材回 workspace
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // 先收菜单再弹确认，避免两个浮层同时存在。
              setPendingDeleteId(projectId);
              close();
            }}
            disabled={busy}
            title="从全局及所有项目物理删除独占素材；共享素材保留"
            className="app-context-item is-danger px-2 py-1.5"
          >
            物理删除独占素材
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
