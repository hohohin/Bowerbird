import { useState } from "react";
import { Loader2, LogOut, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";

/** 侧栏「项目」区：新建（选文件夹导入）+ 项目行。
 *  行内只保留 进入（点击）/ 退出（激活行右侧 icon）；删除与「更新项目文件」都在右键菜单。 */
export function ProjectSection() {
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const enterProject = useStore((s) => s.enterProject);
  const exitProject = useStore((s) => s.exitProject);
  const openProjectContextMenu = useStore((s) => s.openProjectContextMenu);
  const [creating, setCreating] = useState(false);

  async function create() {
    // tour 第 1 步：默认定位到预设图目录的上一级（已释放到文档目录），让用户点进「初始引导」。
    const tourActive = useStore.getState().tourActive;
    const tourStep = useStore.getState().tourStep;
    let defaultPath: string | undefined;
    if (tourActive && tourStep === 1) {
      try {
        defaultPath = await api.releasePresetPack();
      } catch {
        /* 释放失败用系统默认路径 */
      }
    }
    const path = await api.pickFolder(defaultPath);
    if (!path) return;
    // 用户已点 OS「选择文件夹」→ 进入「导入中」步骤（step 2），等导入完成后【下一步】按钮才出现。
    if (tourActive && tourStep === 1) useStore.getState().setTourStep(2);
    setCreating(true);
    try {
      const result = await api.createProject(path);
      await reloadProjects();
      await enterProject(result.project.id);
      notifySuccess(`项目已创建，导入 ${result.imported_count} 张素材`);
      // 导入成功 → 标记完成，让「导入中」步骤的【下一步】按钮出现。
      if (useStore.getState().tourActive && useStore.getState().tourStep === 2) {
        useStore.getState().setTourImported(true);
      }
    } catch (error) {
      notifyError(error, "创建项目失败");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="mb-5 border-b border-edge pb-5">
      <div className="panel-kicker mb-2 flex items-center justify-between">
        <span>项目</span>
        <button
          data-tour="new-project"
          onClick={create}
          disabled={creating}
          className="rounded px-1 text-cold hover:opacity-80 disabled:opacity-50"
          title={creating ? "导入中…" : "新建项目"}
          aria-label="新建项目"
        >
          {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
        </button>
      </div>

      <div className="space-y-1">
        {projects.map((project) => {
          const active = project.id === currentProjectId;
          return (
            <div
              key={project.id}
              data-tour={active ? "active-project" : undefined}
              className={`group rounded-lg px-2.5 py-2 ${
                active ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-panel2"
              }`}
              onContextMenu={(e) => {
                // 项目右键菜单（更新项目文件 / 删除项目）：阻止浏览器原生菜单，store 单实例渲染。
                e.preventDefault();
                openProjectContextMenu(e.clientX, e.clientY, project.id);
              }}
            >
              <div className="flex items-center gap-1">
                <button
                  onClick={() => enterProject(project.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-accent" : "bg-muted"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-ink">{project.name}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {project.asset_count} 张素材
                    </span>
                  </span>
                </button>
                {active && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void exitProject();
                    }}
                    className="rounded px-1 text-muted hover:text-accent focus-visible:opacity-100"
                    title="退出项目 · 返回全局素材"
                    aria-label={`退出项目 ${project.name}`}
                  >
                    <LogOut size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
