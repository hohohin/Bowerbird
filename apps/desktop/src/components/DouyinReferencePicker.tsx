import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";
import type { ReplicationReference } from "../lib/videoReplication";

interface Acquisition {
  id: string;
  state: "starting" | "waiting" | "downloading" | "needs_login" | "failed" | "cancelled" | "interrupted" | "ready";
  message: string;
  shareText: string;
  sourceUrl: string;
  reference?: ReplicationReference;
}
export function DouyinReferencePicker({ projectId, ensureProject, onUse }: { projectId: string; ensureProject: () => Promise<void>; onUse: (reference: ReplicationReference) => void }) {
  const call = <T,>(action: string, data: unknown = {}) => invoke<T>("video_replication", { projectId, action: `douyin-${action}`, data });
  const [text, setText] = useState("");
  const [tasks, setTasks] = useState<Acquisition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  const pendingId = useRef<string | null>(null);
  const onUseRef = useRef(onUse);
  onUseRef.current = onUse;
  function useCompleted(task?: Acquisition) {
    if (task?.id === pendingId.current && task.state === "ready" && task.reference) {
      pendingId.current = null;
      onUseRef.current(task.reference);
    }
  }
  const active = tasks.some(task => ["starting", "waiting", "downloading"].includes(task.state));
  const needsVerification = tasks[0]?.state === "needs_login" && (!text.trim() || text.trim() === tasks[0].shareText.trim());
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const tasks = await call<Acquisition[]>("list");
        if (!disposed) {
          // Resume an in-flight acquisition, but never replace the reference with old history.
          pendingId.current ??= tasks.find(task => ["starting", "waiting", "downloading"].includes(task.state))?.id ?? null;
          setTasks(current => JSON.stringify(current) === JSON.stringify(tasks) ? current : tasks);
          useCompleted(tasks.find(task => task.id === pendingId.current));
        }
      }
      catch (e) { if (!disposed) setError(String(e)); }
      if (!disposed) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);
  async function run(action: string, data: unknown) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError("");
    try {
      await ensureProject();
      const value = await call<Acquisition>(action, data);
      setTasks(items => [value, ...items.filter(item => item.id !== value.id)]);
      pendingId.current = action === "cancel" ? null : value.id;
      useCompleted(value);
    } catch (e) { setError(String(e)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <section className="vr-picker" aria-label="抖音视频获取">
    <label className="vr-field"><textarea aria-label="抖音分享内容" rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder="粘贴完整分享文案或视频链接" /></label>
    {error && <p className="vr-message is-error" role="alert">{error}</p>}
    {!needsVerification && <div className="vr-actions"><button type="button" disabled={busy || active || !text.trim()} onClick={() => void run("create", { text })}>获取抖音视频</button></div>}
    {tasks.map(task => <div className="vr-douyin-record" key={task.id}>
      <p className="vr-hint">{task.shareText}</p>
      <p className="vr-hint" role={task.state === "failed" ? "alert" : "status"}>{["starting", "waiting", "downloading"].includes(task.state) && <LoaderCircle size={13} className="animate-spin inline" />} {task.message}</p>
      <div className="vr-actions">
        {task.state === "ready" && task.reference ? <button type="button" onClick={() => onUse(task.reference!)}>{task.reference.name}</button>
          : ["starting", "waiting", "downloading"].includes(task.state) ? <button type="button" disabled={busy} onClick={() => void run("cancel", { id: task.id })}>取消获取</button>
          : task.state === "needs_login" ? <button type="button" className="is-primary" disabled={busy || active} onClick={() => void run("login", { id: task.id })}>打开抖音窗口</button>
          : <button type="button" disabled={busy || active} onClick={() => void run("retry", { id: task.id })}>重新获取</button>}
      </div>
    </div>)}
  </section>;
}
