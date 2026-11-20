import { useEffect, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { ContextMenuItems } from "./ContextMenuItems";
import { FolderSync, Pencil, Trash2 } from "lucide-react";
import { buildProjectMenu, type ProjectMenuAction } from "../lib/projectMenu";
import { useStore } from "../store";
import { api } from "../lib/api";
import { useProjectDeletion } from "./useProjectDeletion";
import { ProjectRenameDialog } from "./ProjectRenameDialog";
import { notifyError, notifySuccess } from "../lib/notify";

const PROJECT_MENU_ICONS = {
  rename: <Pencil size={13} className="shrink-0" aria-hidden="true" />,
  refresh: <FolderSync size={13} className="shrink-0" aria-hidden="true" />,
  delete: <Trash2 size={13} aria-hidden="true" />,
};

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
  const close = () => { if (useStore.getState().projectContextMenu === menu) useStore.getState().closeProjectContextMenu(); };
  const projects = useStore((s) => s.projects);
  const { busy: deleting, prepareDelete, confirmation } = useProjectDeletion(close);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  // 每次打开重置菜单状态；删除影响在菜单关闭后仍要保留给确认框。
  useEffect(() => {
    setBusy(false);
  }, [menu]);

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
      if (useStore.getState().projectContextMenu === menu) setBusy(false);
    }
  }

  if (!menu) return <>{confirmation}{renaming && <ProjectRenameDialog
    projectId={renaming.id} currentName={renaming.name} onClose={() => setRenaming(null)}
  />}</>;

  const projectId = menu.projectId;
  const project = projects.find((p) => p.id === projectId);
  const actions: Record<ProjectMenuAction, () => void> = {
    rename: () => {
      if (!project) return;
      setRenaming({ id: project.id, name: project.name });
      close();
    },
    refresh: () => void refresh(projectId),
    delete: () => void prepareDelete(projectId),
  };

  return <ContextMenu key={`${projectId}:${menu.x}:${menu.y}`} x={menu.x} y={menu.y} label="项目操作" onClose={close}>
    <ContextMenuItems items={buildProjectMenu(project?.kind, busy, deleting)} icons={PROJECT_MENU_ICONS} onSelect={id => actions[id]()} />
  </ContextMenu>;
}
