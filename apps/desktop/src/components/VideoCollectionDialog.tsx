import type { Asset } from "../lib/types";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { collectVideo, collectionProgress, collectionRunning, saveCollectedVideo, type VideoCollectionTask } from "../lib/videoCollection";
import { userErrorMessage } from "../lib/userError";
import { ModalShell } from "./ModalShell";
import "./VideoCollectionDialog.css";

export function VideoCollectionDialog({ projectId, onClose, onCollected, ensureProject }: {
  projectId: string | null;
  onClose: () => void;
  onCollected: (asset: Asset, projectId: string | null, addToCanvas: boolean) => Promise<void>;
  ensureProject?: () => Promise<void>;
}) {
  // Ownership is fixed when opening. A parent may close/remount when changing projects.
  const [owner] = useState(projectId);
  const [text,setText] = useState("");
  const [tasks,setTasks] = useState<VideoCollectionTask[]>([]);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [saving,setSaving] = useState(false);
  const alive = useRef(true), guard = useRef(false), revision = useRef(0);
  const savedAssets = useRef(new Map<string,Asset>());
  const hasActive = tasks.some(collectionRunning);
  const merge = (task: VideoCollectionTask) => setTasks(items => [task,...items.filter(item => item.id !== task.id)]);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const version = revision.current;
      try {
        const items = await collectVideo<VideoCollectionTask[]>(owner,"list");
        if (!disposed && revision.current === version && !guard.current) setTasks(current => JSON.stringify(current) === JSON.stringify(items) ? current : items);
      } catch(e) { if (!disposed) setError(userErrorMessage(e,"采集记录未能读取，请重新打开窗口。")); }
      if (!disposed) timer = setTimeout(poll,1000);
    }
    void poll();
    return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  },[owner]);

  async function act(action: string,data: object) {
    if (action === "create" && !text.trim()) return;
    if (guard.current) return;
    guard.current = true; revision.current++; setBusy(true); setError("");
    try {
      if (action === "create") await ensureProject?.();
      const task = await collectVideo(owner,action,data);
      if (alive.current) merge(task);
    } catch(e) { if (alive.current) setError(userErrorMessage(e,"视频获取未完成，请检查链接后重试。")); }
    finally { guard.current = false; revision.current++; if (alive.current) setBusy(false); }
  }

  async function save(task: VideoCollectionTask,addToCanvas: boolean) {
    if (guard.current) return;
    guard.current = true; revision.current++; setSaving(true); setError("");
    try {
      await ensureProject?.();
      const asset = savedAssets.current.get(task.id) ?? await saveCollectedVideo(owner,task.id);
      savedAssets.current.set(task.id,asset);
      await onCollected(asset,owner,addToCanvas);
      if (alive.current) merge({...task,assetId:asset.id});
    } catch(e) { if (alive.current) setError(userErrorMessage(e,"视频未能保存，请重试；已获取的视频会保留。")); }
    finally { guard.current = false; revision.current++; if (alive.current) setSaving(false); }
  }

  return <ModalShell title="采集视频" width="md" className="video-collection-dialog" onClose={onClose} preventClose={saving}>
    <div className="video-collection-content">
      <form onSubmit={event => {event.preventDefault(); void act("create",{text});}}>
        <textarea aria-label="视频链接" data-modal-autofocus rows={3} maxLength={8000} value={text} onChange={event => setText(event.target.value)} placeholder="粘贴抖音分享文案或视频文件链接"/>
        <div className="video-collection-actions"><button className="is-primary" disabled={busy || saving || hasActive || !text.trim()} type="submit">获取视频</button></div>
      </form>
      {error && <p className="video-collection-error" role="alert">{error}</p>}
      <div className="video-collection-list">
        {tasks.map(task => {
          const running = collectionRunning(task);
          const progress = collectionProgress(task);
          return <article key={task.id}>
            <p className="video-collection-name" title={task.sourceUrl}>{task.reference?.name || task.sourceUrl}</p>
            <div className="video-collection-status" role="status">
              {running && <LoaderCircle aria-hidden size={14} className="animate-spin"/>}
              <span>{task.state === "ready" ? "视频已获取" : task.state === "cancelled" ? "已取消视频获取" : userErrorMessage(task.message,"视频获取未完成，请重新获取。")}</span>
              {progress && <span>{progress}</span>}
            </div>
            {running && !!task.totalBytes && <progress aria-label="视频下载进度" max={task.totalBytes} value={task.downloadedBytes || 0}/>}
            <div className="video-collection-actions">
              {task.state === "ready" ? <>
                <button disabled={busy || saving || !!task.assetId} onClick={() => void save(task,false)}>{task.assetId ? "已保存" : "保存到素材库"}</button>
                {owner && <button disabled={busy || saving} onClick={() => void save(task,true)}>添加到画板</button>}
              </> : running ? <button disabled={busy || saving} onClick={() => void act("cancel",{id:task.id})}>取消获取</button>
                : task.state === "needs_login" ? <button className="is-primary" disabled={busy || saving || hasActive} onClick={() => void act("login",{id:task.id})}>打开抖音窗口</button>
                : <button disabled={busy || saving || hasActive} onClick={() => void act("retry",{id:task.id})}>重新获取</button>}
            </div>
          </article>;
        })}
      </div>
    </div>
  </ModalShell>;
}
