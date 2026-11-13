import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { changeFileTask, FILE_TASKS_UPDATED, listFileTasks, type FileTaskStatus } from "../lib/fileTasks";
import { notify, notifyError } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { ModalShell } from "./ModalShell";

const active = (task: FileTaskStatus) => task.phase === "running" || task.phase === "stopping";

function summary(task: FileTaskStatus) {
  if (task.phase === "stopping") return "正在停止，当前项结束后停止";
  if (task.phase === "running") return `已处理 ${task.completed} / ${task.total} 项`;
  const parts: string[] = [];
  if (task.recycled) parts.push(`已将 ${task.recycled} 个原文件放入回收站`);
  if (task.cleaned) parts.push(`已清理 ${task.cleaned} 个失效条目`);
  if (task.succeeded && !task.recycled && !task.cleaned) parts.push(`已完成 ${task.succeeded} 项`);
  if (task.skipped) parts.push(`无需更改 ${task.skipped} 项`);
  if (task.failures.length) parts.push(`未完成或待核对 ${task.failures.length} 项`);
  if (task.omissions?.length) parts.push(`预检跳过 ${task.omissions.length} 项`);
  if (task.phase === "cancelled") parts.push(`已停止，${task.total - task.completed} 项未执行`);
  return parts.join("，");
}

export function FileTaskStatusPanel() {
  const [tasks, setTasks] = useState<FileTaskStatus[]>([]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true, fetching = false, again = false;
    let timer: number | undefined;
    const announced = new Set<string>();
    async function refresh() {
      if (!alive) return;
      window.clearTimeout(timer);
      if (fetching) { again = true; return; }
      fetching = true;
      let poll = false;
      try {
        const latest = await listFileTasks();
        if (!alive) return;
        setTasks(latest);
        poll = latest.some(active);
        for (const task of latest) {
          if (active(task) || announced.has(task.id)) continue;
          announced.add(task.id);
          notify(summary(task), task.failures.length || task.omissions?.length || task.phase === "cancelled" ? "info" : "success",
            { label: "查看文件任务", onClick: () => setExpanded(true) });
        }
      } catch (error) {
        console.error("Read file task progress", error);
        poll = true;
      } finally {
        fetching = false;
        if (alive && (again || poll)) timer = window.setTimeout(refresh, again ? 0 : 800);
        again = false;
      }
    }
    const unlisten = listen(FILE_TASKS_UPDATED, refresh);
    window.addEventListener(FILE_TASKS_UPDATED, refresh);
    void unlisten.then(refresh).catch(console.error);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      void unlisten.then(stop => stop()).catch(console.error);
      window.removeEventListener(FILE_TASKS_UPDATED, refresh);
    };
  }, []);

  useEffect(() => { if (!tasks.length) setExpanded(false); }, [tasks.length]);
  if (!tasks.length) return null;
  const current = tasks.find(active);
  const act = (action: "cancel" | "retry" | "dismiss", id: string) => {
    void changeFileTask(action, id).catch(error => notifyError(error, "文件任务状态未更新，请查看进度后重试。"));
  };
  return <>
    <button type="button" className="app-modal-button fixed bottom-3 right-3 z-40 border border-edge bg-panel"
      aria-label="查看文件任务" onClick={() => setExpanded(true)}>
      文件任务 · {current ? `${current.completed}/${current.total}` : `${tasks.length} 条结果`}
    </button>
    {expanded && <ModalShell title="文件任务" onClose={() => setExpanded(false)} footer={
      <button type="button" className="app-modal-button" onClick={() => setExpanded(false)}>
        {current ? "后台继续" : "关闭"}
      </button>}>
      <ul className="space-y-4">{tasks.slice().reverse().map(task => <li key={task.id}>
        <strong>{task.title}</strong>
        <p role="status" className="my-1 text-sm">{summary(task)}</p>
        {!!task.omissions?.length && <details><summary className="cursor-pointer text-sm">查看预检跳过的 {task.omissions.length} 项</summary>
          <ul className="mt-1 space-y-1 text-xs">{task.omissions.map((item, i) => <li key={i}>{item.label} · {item.message}</li>)}</ul>
        </details>}
        {!!task.failures.length && <details><summary className="cursor-pointer text-sm">查看未完成项</summary>
          <ul className="mt-1 space-y-1 text-xs">{task.failures.map(failure => <li key={failure.id}>
            {failure.label} · {userErrorMessage(failure.message, failure.retryable ? "操作未完成，请重试。" : "请刷新并核对磁盘和文件夹列表。")}
          </li>)}</ul>
        </details>}
        {active(task) ? <button type="button" className="app-modal-button" disabled={task.phase === "stopping"}
          onClick={() => act("cancel", task.id)}>取消剩余项</button> : <div className="flex gap-2">
          {task.failures.some(f => f.retryable) && !task.retryId && <button type="button" className="app-modal-button"
            onClick={() => act("retry", task.id)}>重试失败项</button>}
          <button type="button" className="app-modal-button" onClick={() => act("dismiss", task.id)}>收起此结果</button>
        </div>}
      </li>)}</ul>
    </ModalShell>}
  </>;
}
