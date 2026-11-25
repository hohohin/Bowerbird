import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { Asset } from "../lib/types";
import { replicationAnalysisParts, replicationRewriteParts, type ReplicationCase } from "../lib/videoReplication";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";
import { replicationCall } from "./replicationTaskState";
import { ModalShell } from "./ModalShell";
import { VideoCollectionDialog } from "./VideoCollectionDialog";
import { VideoPlayer } from "./VideoPlayer";
import "./VideoReplication.css";

interface Props {
  projectId: string; ensureProject: () => Promise<void>; onClose: () => void;
  onOpenReplication: (asset: Asset) => void; onAddVideo: (asset: Asset, operationId: string) => Promise<void>;
}
type Enhanced = {
  slices?: {index:number; start:number; end:number}[];
  analysis?: {index:number; analysis?: {analysisText?:string}}[];
  speech?: {text?:string}; prompts?: {index:number; prompt:string}[]; frozenPrompts?: {index:number; prompt:string}[];
  outputPath?:string;
};
export function VideoReplicationDialog({projectId,onClose,ensureProject,onOpenReplication,onAddVideo}: Props) {
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.name ?? "当前项目");
  const [history,setHistory] = useState(false);
  if (history) return <ReplicationHistory projectId={projectId} onBack={() => setHistory(false)} onClose={onClose}/>;
  return <VideoCollectionDialog projectId={projectId} ensureProject={ensureProject} onClose={onClose}
    toolbox={{projectName,onHistory:() => setHistory(true),onOpenReplication}}
    onCollected={async (asset,_owner,add) => { if (add) await onAddVideo(asset,"douyin-" + asset.id); }}/>;
}
function ReplicationHistory({ projectId,onBack,onClose }: { projectId:string; onBack:()=>void; onClose:()=>void }) {
  const [records,setRecords] = useState<ReplicationCase[]>();
  const [item,setItem] = useState<ReplicationCase>();
  const [enhanced,setEnhanced] = useState<Enhanced>();
  const [error,setError] = useState("");
  const [retry,setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    const load = item?.enhancedId
      ? replicationCall<Enhanced>(projectId,"enhanced-read",{id:item.enhancedId}).then(r => {if (live) setEnhanced(r);})
      : !item ? replicationCall<ReplicationCase[]>(projectId,"case-list").then(r => {if (live) setRecords(r);}) : Promise.resolve();
    void load.catch(e => {if (live) setError(userErrorMessage(e,"历史复刻记录未能读取，请重试。"));});
    return () => {live=false;};
  },[projectId,item,retry]);
  const oldAnalysis = item?.analysisJob && replicationAnalysisParts(item.analysisJob);
  const oldRewrite = item?.rewriteJob && replicationRewriteParts(item.rewriteJob.rewrittenText || "");
  const fields = item && [
    ["画面描述",item.analysisText || oldAnalysis?.analysisText],["转录文稿",item.transcript || oldAnalysis?.transcript || enhanced?.speech?.text],
    ["改写方向",item.rewriteDirection],["改写分镜",item.rewrittenText || oldRewrite?.text],
    ["首帧提示词",item.firstFramePrompt || item.rewriteJob?.firstFramePrompt || oldRewrite?.firstFramePrompt],
  ];
  return <ModalShell title={item?.title || "历史复刻记录"} width="md" className="video-replication" onClose={onClose}
    headerActions={<button type="button" className="asset-detail-back" onClick={() => item ? setItem(undefined) : onBack()}><ArrowLeft size={15}/>返回</button>}>
    {error && <p role="alert">{error} <button type="button" className="app-button-secondary" onClick={() => setRetry(n => n + 1)}>重试</button></p>}
    {item ? <section aria-label="只读记录" className="vr-manager-body">
      <p className="vr-hint">历史记录 · 只读</p>
      {item.mediaPath && <VideoPlayer path={item.mediaPath} embedded/>}
      {fields?.map(([label,value]) => value && <div key={label}><h4>{label}</h4><p className="whitespace-pre-wrap">{value}</p></div>)}
      {enhanced?.slices?.map(s => <div key={s.index}><h4>镜头 {s.index + 1} · {s.start.toFixed(2)}–{s.end.toFixed(2)} 秒</h4>
        <p className="whitespace-pre-wrap">{enhanced.analysis?.find(a => a.index === s.index)?.analysis?.analysisText}</p>
        <p className="whitespace-pre-wrap">{(enhanced.frozenPrompts || enhanced.prompts)?.find(p => p.index === s.index)?.prompt}</p></div>)}
      {enhanced?.outputPath && <VideoPlayer path={enhanced.outputPath} embedded/>}
    </section> : !records ? <p role="status">{error ? "" : "正在读取历史记录…"}</p> : records.length ?
      <div className="vr-task-grid">{records.map(record => <button type="button" className="vr-task-tile" key={record.id}
        onClick={() => {setEnhanced(undefined);setItem(record);}}><strong>{record.title || record.reference?.name || "复刻任务"}</strong>
        <span>{record.reference?.name}</span></button>)}</div> : <p>暂无历史复刻记录</p>}
  </ModalShell>;
}
