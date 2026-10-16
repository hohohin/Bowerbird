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
  const active = tasks.some(task => ["starting", "waiting", "downloading"].includes(task.state));
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const tasks = await call<Acquisition[]>("list"); if (!disposed) setTasks(tasks); }
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
    } catch (e) { setError(String(e)); }
    finally { guard.current = false; setBusy(false); }
  }
  return <section className="vr-product-editor" aria-label="抖音视频获取">
    <h3>从抖音获取参考视频</h3>
    <label className="vr-field">抖音分享内容<textarea rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder="粘贴完整分享文案或视频链接" /></label>
    <p className="vr-hint">先获取视频，再由你点击分析。需要登录或验证时，可打开独立的抖音窗口。</p>
    {error && <p className="vr-message is-error" role="alert">{error}</p>}
    <div className="vr-actions"><button type="button" disabled={busy || active || !text.trim()} onClick={() => void run("create", { text })}>获取抖音视频</button></div>
    {tasks.map(task => <div className="vr-douyin-record" key={task.id}>
      <p className="vr-hint">{task.shareText}</p>
      <p className="vr-hint" role="status">{["starting", "waiting", "downloading"].includes(task.state) && <LoaderCircle size={13} className="animate-spin inline" />} {task.message}</p>
      <div className="vr-actions">
        {task.state === "ready" && task.reference ? <button type="button" onClick={() => onUse(task.reference!)}>使用此视频：{task.reference.name}</button>
          : ["starting", "waiting", "downloading"].includes(task.state) ? <button type="button" disabled={busy} onClick={() => void run("cancel", { id: task.id })}>取消获取</button>
          : <><button type="button" disabled={busy || active} onClick={() => void run("login", { id: task.id })}>打开登录 / 验证窗口</button><button type="button" disabled={busy || active} onClick={() => void run("retry", { id: task.id })}>重新获取</button></>}
      </div>
    </div>)}
  </section>;
}
