import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { Film, Plus } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { ReplicationPoster } from "./ReplicationPoster";
import { ReplicationTaskPanel } from "./ReplicationTaskPanel";
import { REPLICATION_PERSONA, REPLICATION_RULES, type ReplicationCase } from "../lib/videoReplication";
import { replicationCall, replicationSteps, replicationSourceKey, type ReplicationDialogProps } from "./replicationTaskState";
import "./VideoReplication.css";

export function VideoReplicationDialog(props: ReplicationDialogProps) {
  const [cases, setCases] = useState<ReplicationCase[]>([]), [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [creating, setCreating] = useState(false), guard = useRef(false), alive = useRef(true);
  const [defaults, setDefaults] = useState({ persona: REPLICATION_PERSONA, rules: REPLICATION_RULES });
  useEffect(() => {
    alive.current = true; let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function read() {
      try { const result = await replicationCall<ReplicationCase[]>(props.projectId, "case-list"); if (!disposed) { setCases(result); setError(""); } }
      catch (e) { if (!disposed) setError(String(e)); }
      finally { if (!disposed) { setLoading(false); timer = setTimeout(read, 2500); } }
    }
    void replicationCall<{ persona?: string; rules?: string }>(props.projectId, "preferences").then(p => { if (!disposed) setDefaults({ persona: p.persona || REPLICATION_PERSONA, rules: p.rules || REPLICATION_RULES }); }).catch(e => !disposed && setError(String(e)));
    void read();
    return () => { alive.current = false; disposed = true; clearTimeout(timer); };
  }, [props.projectId]);
  function put(value: ReplicationCase) { setCases(items => [value, ...items.filter(item => item.id !== value.id)]); }
  async function create() {
    if (guard.current) return;
    guard.current = true; setCreating(true); setError("");
    try {
      await props.ensureProject();
      const source = localStorage.getItem(replicationSourceKey);
      const value: ReplicationCase = { id: crypto.randomUUID().replaceAll("-", ""), projectId: props.projectId, title: "未命名复刻任务", createdAt: new Date().toISOString(), step: 1,
        sourceMethod: source === "local" || source === "library" ? source : "douyin", shareText: "", ...defaults };
      await replicationCall(props.projectId, "case-save", value);
      if (alive.current) { put(value); setSelected(value.id); }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { guard.current = false; if (alive.current) setCreating(false); }
  }
  const current = cases.find(item => item.id === selected);
  if (current) return <ReplicationTaskPanel key={current.id} {...props} initial={current} defaults={defaults} onUpdate={put} onBack={() => setSelected(null)} />;
  return <ModalShell title="复刻任务" eyebrow="工具箱" width="lg" className="video-replication vr-manager" onClose={props.onClose} preventClose={creating}
    headerActions={<div className="vr-actions"><button className="is-primary" disabled={creating || loading} onClick={() => void create()}><Plus size={16} />新建任务</button></div>}>
    <div className="vr-manager-body">
      {error && <p className="vr-message is-error" role="alert">{userErrorMessage(error, "视频复刻任务未能加载，请稍后重试。")}</p>}
      {loading ? <p role="status">正在读取复刻任务…</p> : !cases.length ? <div className="vr-empty-tasks"><Film size={32} /><p>从一个参考视频开始</p><span>新建任务，获取视频后继续分析与改写。</span></div> : <div className="vr-task-grid">
        {cases.map(item => <button className="vr-task-tile" key={item.id} onClick={() => setSelected(item.id)}>
          <div className="vr-task-cover">{item.referenceId ? <ReplicationPoster projectId={props.projectId} referenceId={item.referenceId} alt={item.title || "参考视频"} /> : <><Film size={30} /><span>待获取视频</span></>}</div>
          <strong>{item.reference?.name || item.title || "未命名复刻任务"}</strong><span>{replicationSteps[(item.step || 1) - 1]}</span>
          <small>{item.shareText || (item.sourceMethod === "local" ? "本地视频" : item.sourceMethod === "library" ? "素材库视频" : "等待参考链接")}</small>
        </button>)}
      </div>}
    </div>
  </ModalShell>;
}
