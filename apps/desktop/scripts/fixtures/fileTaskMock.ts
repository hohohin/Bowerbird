import type { AssetOriginal } from "../../src/lib/assetOriginals";
import { FILE_TASKS_UPDATED, type FileTaskStatus } from "../../src/lib/fileTasks";

// Exercise the real confirmation and task panel against controlled per-file outcomes.
export function installDeletionTaskMock() {
  const ipc = (window as any).__TAURI_INTERNALS__;
  const invoke = ipc.invoke.bind(ipc);
  const tasks = new Map<string, FileTaskStatus>();
  const selections = new Map<string, AssetOriginal[]>();
  const changed = () => window.dispatchEvent(new Event(FILE_TASKS_UPDATED));
  function start(id: string, title: string, originals: AssetOriginal[]) {
    if (tasks.has(id)) return;
    const task: FileTaskStatus = { id, title, phase: "running", total: originals.length, completed: 0,
      succeeded: 0, skipped: 0, recycled: 0, cleaned: 0, failures: [], retryId: null };
    tasks.set(id, task);
    selections.set(id, originals);
    void (async () => {
      for (const original of originals) {
        if (task.phase === "stopping") break;
        try {
          await ipc.invoke("trash_asset_original", { original });
          task.succeeded++;
          if (original.missing) task.cleaned++; else task.recycled++;
        } catch (error) {
          task.failures.push({ id: original.asset_id, label: original.name, retryable: true, message: String(error) });
        }
        task.completed++;
      }
      task.phase = task.phase === "stopping" ? "cancelled" : "finished";
      changed();
    })();
  }
  ipc.invoke = async (command: string, args: any) => {
    if (command === "start_file_task" && args.request.kind === "delete") return start(args.id, args.title, args.request.originals);
    if (command === "list_file_tasks") return structuredClone([...tasks.values()]);
    if (command === "cancel_file_task") { tasks.get(args.id)!.phase = "stopping"; return; }
    if (command === "retry_file_task") {
      const parent = tasks.get(args.id)!;
      parent.retryId = args.newId;
      return start(args.newId, parent.title, selections.get(args.id)!.filter(o => parent.failures.some(f => f.id === o.asset_id && f.retryable)));
    }
    if (command === "dismiss_file_task") { tasks.delete(args.id); selections.delete(args.id); return; }
    return invoke(command, args);
  };
}
