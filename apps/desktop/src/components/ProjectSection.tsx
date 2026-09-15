import { LogOut } from "lucide-react";
import { useStore } from "../store";
import { NewProjectMenu } from "./NewProjectMenu";
import { summarizeProjectActivity } from "../lib/projectActivity";
import { notifyError } from "../lib/notify";
import { agentReminderKey, generationReminderKey } from "../lib/taskReminders";
import { useTaskReminders } from "../lib/useTaskReminders";
import { useProjectAssetDrop } from "../lib/useProjectAssetDrop";

/** 侧栏「项目」区：新建入口（NewProjectMenu 菜单：空白项目 / 导入文件夹）+ 项目行。
 *  行内只保留 进入（点击）/ 退出（激活行右侧 icon）；删除与「更新项目文件」都在右键菜单。 */
export function ProjectSection() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projectRoutePending = useStore((s) => s.projectRoutePending);
  const enterProject = useStore((s) => s.enterProject);
  const exitProject = useStore((s) => s.exitProject);
  const openProjectContextMenu = useStore((s) => s.openProjectContextMenu);
  const genJobs = useStore((s) => s.genJobs);
  const cloudAgentRuns = useStore((s) => s.cloudAgentRuns);
  const projectUnreadThreads = useStore((s) => s.projectUnreadThreads);
  const reminders = useTaskReminders();
  const projectDrop = useProjectAssetDrop();

  return (
    <section className="mb-5 border-b border-edge pb-5">
      <div className="panel-kicker mb-2 flex items-center justify-between">
        <span>项目</span>
        <NewProjectMenu />
      </div>

      <div className="space-y-1">
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          const activity = summarizeProjectActivity({
            projectId: project.id,
            unreadThreadIds: projectUnreadThreads[project.id] ?? [],
            generationJobs: Object.values(genJobs).filter((job) => !reminders.isCleared(generationReminderKey(job))),
            agentRuns: Object.values(cloudAgentRuns).filter((run) => !reminders.isCleared(agentReminderKey(run))),
          });
          return (
            <div
              key={project.id}
              {...projectDrop(project)}
              data-tour={active ? "active-project" : undefined}
              className={`sidebar-nav-item group rounded-lg px-2.5 py-2 ${active ? "is-active" : ""}`}
              onContextMenu={(e) => {
                // 项目右键菜单（更新项目文件 / 删除项目）：阻止浏览器原生菜单，store 单实例渲染。
                e.preventDefault();
                openProjectContextMenu(e.clientX, e.clientY, project.id);
              }}
            >
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void enterProject(project.id).catch((error) => {
                    notifyError(error, "无法切换项目，当前画板保持不变");
                  })}
                  disabled={projectRoutePending}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-accent" : "bg-muted"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="project-name block truncate text-xs">{project.name}</span>
                    <span className="flex items-center gap-1.5 truncate text-[10px] text-muted">
                      <span>{project.asset_count} 张素材</span>
                      {activity.running > 0 && <span className="text-accent">运行中 {activity.running}</span>}
                      {activity.failed > 0 && <span className="text-red-500">失败 {activity.failed}</span>}
                      {activity.unread > 0 && <span className="text-blue-500">未读 {activity.unread}</span>}
                    </span>
                  </span>
                </button>
                {active && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void exitProject().catch((error) => {
                        notifyError(error, "项目仍有未保存修改，已留在当前画板");
                      });
                    }}
                    disabled={projectRoutePending}
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
