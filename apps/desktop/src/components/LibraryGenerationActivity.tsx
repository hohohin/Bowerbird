import { ArrowUpRight, Check, ChevronDown, CircleAlert, LoaderCircle } from "lucide-react";
import { useStore } from "../store";
import { useLocalChatStore } from "../lib/localChatStore";
import { libraryGenerationTasks, type LibraryActivityTask } from "../lib/libraryGenerationActivity";
import { openLibraryActivityTask, useLibraryGenerationRuntime } from "../lib/libraryGenerationRuntime";
import "./LibraryGenerationActivity.css";

function ActivitySummary({ running, unread }: { running: number; unread: boolean }) {
  return <summary aria-label={`近期任务${running ? `，${running} 项进行中` : ""}${unread ? "，有未读结果" : ""}`}>
    <span>近期任务</span>{running > 0 && <span className="library-generation-running">{running} 进行中</span>}
    {unread && <i className="library-generation-unread" aria-label="有未读结果" />}<ChevronDown size={14} aria-hidden />
  </summary>;
}

function ActivityRow({ task, projectName, open }: { task: LibraryActivityTask; projectName: string; open: (task: LibraryActivityTask) => void }) {
  const Icon = task.status === "running" ? LoaderCircle : task.status === "completed" ? Check : CircleAlert;
  return <div role="listitem"><button type="button"
    className={`library-generation-task is-${task.status}`} onClick={() => open(task)}
    aria-label={`${projectName} · ${task.title} · ${task.statusLabel}，查看画板`}>
    <Icon size={14} aria-hidden /><span className="library-generation-task-copy"><span>{task.title}</span><small>{projectName}</small></span>
    <span className="library-generation-task-status">{task.statusLabel}</span><ArrowUpRight size={13} aria-hidden />
  </button></div>;
}

function openRecentTask(task: LibraryActivityTask, onOpenExtra?: (task: LibraryActivityTask) => void) {
  const state = useStore.getState();
  if (task.source === "generation") state.openGenerationJob(task.id);
  else if (task.source === "agent") state.openCloudAgentRun(state.cloudAgentRuns[task.id]);
  else if (task.source === "extra" && onOpenExtra) onOpenExtra(task);
  else openLibraryActivityTask(task);
}

export function LibraryGenerationActivity({ extraTasks = [], onOpenExtra }: {
  extraTasks?: readonly LibraryActivityTask[];
  onOpenExtra?: (task: LibraryActivityTask) => void;
}) {
  const projects = useStore(state => state.projects);
  const jobs = useStore(state => state.genJobs);
  const runs = useStore(state => state.cloudAgentRuns);
  const unread = useStore(state => state.projectUnreadThreads);
  const chats = useLocalChatStore(state => state.summaries);
  const localVideoTasks = useLibraryGenerationRuntime(state => state.tasks);
  const tasks = libraryGenerationTasks({ projects, jobs: Object.values(jobs), runs: Object.values(runs), chats: Object.values(chats), extraTasks: [...Object.values(localVideoTasks), ...extraTasks] });
  const running = tasks.filter(task => task.status === "running").length;
  const hasUnread = tasks.some(task => unread[task.projectId]?.includes(task.threadId));
  return <details className="library-generation-activity">
    <ActivitySummary running={running} unread={hasUnread}/>
    <div className="library-generation-task-list" role="list" aria-label="近期任务">
      {!tasks.length && <p className="library-generation-empty">暂无任务</p>}
      {tasks.map(task => <ActivityRow key={`${task.source}:${task.id}`} task={task}
        projectName={projects.find(project => project.id === task.projectId)?.name ?? "项目"}
        open={task => openRecentTask(task, onOpenExtra)}/>)}
    </div>
  </details>;
}
