import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Film } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { VideoPlayer } from "./VideoPlayer";
import { DouyinReferencePicker } from "./DouyinReferencePicker";
import { useReplicationCapabilities } from "./useReplicationCapabilities";
import { replicationDuration, replicationRewriteParts, replicationRunning, type ReplicationCase, type ReplicationReference, type ReplicationTask } from "../lib/videoReplication";
import { api } from "../lib/api";
import { videoTime, type VideoFrame } from "../lib/videoFrame";
import type { Asset } from "../lib/types";
import { replicationCall as call, replicationSteps as steps, replicationSourceKey as sourceKey, type ReplicationDialogProps } from "./replicationTaskState";

export function ReplicationTaskPanel({ initial, defaults, onUpdate, onBack, ...props }: ReplicationDialogProps & { initial: ReplicationCase; defaults: { persona: string; rules: string }; onUpdate: (value: ReplicationCase) => void; onBack: () => void }) {
  const [draft, setDraft] = useState<ReplicationCase>(() => ({ ...defaults, ...initial }));
  const draftRef = useRef(draft), revision = useRef(0), savedRevision = useRef(-1);
  const queue = useRef(Promise.resolve()), timer = useRef<ReturnType<typeof setTimeout>>();
  const alive = useRef(true), busyRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saveStatus, setSaveStatus] = useState("已保存");
  const [media, setMedia] = useState<string | null>(null), [mediaError, setMediaError] = useState("");
  const [sources, setSources] = useState<Asset[]>([]), [query, setQuery] = useState(""), [offset, setOffset] = useState(0);
  const [framePreview, setFramePreview] = useState("");
  const caps = useReplicationCapabilities(props.projectId);
  const analysisJob = initial.analysisJob, rewriteJob = initial.rewriteJob;
  const running = !!(analysisJob && replicationRunning(analysisJob) || rewriteJob && replicationRunning(rewriteJob));
  const step = draft.step || 1;
  async function flush() {
    clearTimeout(timer.current);
    const result = queue.current.catch(() => {}).then(async () => {
      if (savedRevision.current === revision.current) return;
      const snapshot = draftRef.current, version = revision.current;
      await call(props.projectId, "case-save", snapshot);
      savedRevision.current = version;
      if (alive.current && revision.current === version) setSaveStatus("已保存");
    });
    queue.current = result;
    try { await result; } catch (e) { if (alive.current) setSaveStatus("保存失败"); throw e; }
  }
  function change(patch: Partial<ReplicationCase>) {
    const next = { ...draftRef.current, ...patch };
    if ((["rewrittenText", "firstFramePrompt", "frameReference"] as const).some(key => key in patch && JSON.stringify(patch[key]) !== JSON.stringify(draftRef.current[key]))) next.workflowId = "";
    draftRef.current = next; revision.current++; setDraft(next); setSaveStatus("正在保存…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush().catch(e => { if (alive.current) { setSaveStatus("保存失败"); setError(String(e)); } }), 250);
  }
  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); void flush().catch(() => {}); }; }, []);
  useEffect(() => {
    const patch: Partial<ReplicationCase> = {};
    if (!draftRef.current.referenceId && initial.referenceId) Object.assign(patch, { referenceId: initial.referenceId, reference: initial.reference, step: 2, title: initial.reference?.name?.slice(0,100) || draftRef.current.title });
    if (analysisJob?.analysis && draftRef.current.appliedAnalysisId !== analysisJob.id) Object.assign(patch, { analysisText: analysisJob.analysis, appliedAnalysisId: analysisJob.id, step: 2 });
    if (rewriteJob?.rewriteOriginalText && draftRef.current.appliedRewriteId !== rewriteJob.id) {
      const parts = replicationRewriteParts(rewriteJob.rewrittenText || rewriteJob.rewriteOriginalText);
      Object.assign(patch, { rewrittenText: parts.text, firstFramePrompt: rewriteJob.firstFramePrompt ?? parts.firstFramePrompt, appliedRewriteId: rewriteJob.id, step: 4 });
    }
    if (Object.keys(patch).length) change(patch);
  }, [initial.referenceId, analysisJob?.id, analysisJob?.analysis, rewriteJob?.id, rewriteJob?.rewriteOriginalText]);
  useEffect(() => {
    let disposed = false; setMedia(null); setMediaError("");
    if (draft.referenceId) void call<string>(props.projectId, "media", { id: draft.referenceId }).then(path => !disposed && setMedia(path)).catch(e => !disposed && setMediaError(String(e)));
    return () => { disposed = true; };
  }, [draft.referenceId, props.projectId]);
  useEffect(() => {
    let disposed = false;
    if (step === 1 && draft.sourceMethod === "library" && !draft.referenceId) void call<Asset[]>(props.projectId, "sources", { query, offset }).then(items => !disposed && setSources(items)).catch(e => !disposed && setError(String(e)));
    return () => { disposed = true; };
  }, [step, draft.sourceMethod, query, offset, draft.referenceId]);
  useEffect(() => {
    let disposed = false; setFramePreview("");
    if (draft.frameReference) void api.getAssetsByIds([draft.frameReference.assetId]).then(items => { if (!disposed && items[0]?.store_path) setFramePreview(convertFileSrc(items[0].store_path)); }).catch(e => !disposed && setError(String(e)));
    return () => { disposed = true; };
  }, [draft.frameReference?.assetId]);
  async function useReference(reference: ReplicationReference) {
    change({ referenceId: reference.id, reference, title: reference.name.slice(0,100), step: 2 }); await flush();
  }
  async function choose(data: { path?: string; assetId?: string }) { await flush(); await useReference(await call<ReplicationReference>(props.projectId, "reference", data)); }
  async function capture(frame: VideoFrame) {
    const asset = await api.importImageBytes({ dataUrl: frame.dataUrl, projectId: props.projectId, source: "video-frame", fileName: `复刻参考-${frame.time.toFixed(3)}.png` });
    if (!alive.current) return;
    change({ frameReference: { assetId: asset.id, time: frame.time, name: draftRef.current.reference?.name || "参考视频" } }); await flush();
  }
  async function submit(operation: "analyze" | "rewrite") {
    const value = draftRef.current;
    if (!value.referenceId || !media) throw new Error("请先获取并加载参考视频");
    if (operation === "rewrite" && !value.analysisText?.trim()) throw new Error("请先分析视频");
    await flush();
    const job = await call<ReplicationTask>(props.projectId, "create", { caseId: value.id, operation, title: value.title, referenceId: value.referenceId,
      inputText: value.analysisText, rewriteDirection: value.rewriteDirection, persona: value.persona, rules: value.rules, frameReference: value.frameReference, product: null, ratio: "9:16" });
    onUpdate({ ...initial, ...draftRef.current, ...(operation === "analyze" ? { analysisJob: job } : { rewriteJob: job }) });
  }
  async function exit(back: boolean) { await flush(); onUpdate({ ...initial, ...draftRef.current }); back ? onBack() : props.onClose(); }
  async function workflow() {
    const value = draftRef.current;
    if (!props.onCreateWorkflow || !value.firstFramePrompt?.trim() || !value.rewrittenText?.trim()) throw new Error("请填写改写结果与首帧画面提示词");
    if (!value.workflowId) change({ workflowId: crypto.randomUUID() });
    await flush();
    await props.onCreateWorkflow({ id: draftRef.current.workflowId!, prompt: value.firstFramePrompt, videoPrompt: value.rewrittenText, referenceId: value.frameReference?.assetId, ratio: "9:16", duration: replicationDuration(value.rewrittenText) ?? 5 });
    props.onClose();
  }
  const capability = caps.services.find(s => s.operation === (step === 2 ? "video-analysis" : "text-rewrite"));
  const job = step === 2 ? analysisJob : rewriteJob;
  const price = capability?.available ? ` · ${capability.credits} 积分` : "";
  const canStep = (index: number) => index === 1 || !!draft.referenceId && (index === 2 || !!draft.appliedAnalysisId && !!draft.analysisText?.trim() && (index === 3 || !!draft.appliedRewriteId));
  return <ModalShell title={draft.reference?.name || draft.title || "复刻任务"} eyebrow="视频复刻" width="lg" className="video-replication vr-task-panel" onClose={() => void action(() => exit(false))} preventClose={busy}
    headerActions={<div className="vr-actions"><span className="vr-hint" role="status">{saveStatus}</span><button disabled={busy} onClick={() => void action(() => exit(true))}><ArrowLeft size={15} />全部任务</button></div>}>
    <div className="vr-task-layout">
      <nav className="vr-step-nav" aria-label="复刻步骤">{steps.map((name, index) => <button key={name} aria-current={step === index + 1 ? "step" : undefined} disabled={busy || !canStep(index + 1)} onClick={() => change({ step: (index + 1) as ReplicationCase["step"] })}><span>{index + 1}</span><div><small>流程 {index + 1}</small><strong>{name}</strong></div></button>)}</nav>
      <section className="vr-fixed-video" aria-label="任务参考视频">
        {media ? <VideoPlayer key={media} path={media} embedded onReferenceFrame={capture} onAddFrame={props.onAddFrame} /> : <div className="vr-video-placeholder"><Film size={36} /><p>{draft.referenceId ? "正在载入参考视频…" : "请先在右侧获取视频"}</p><button disabled>添加该帧为参考图</button><button disabled>添加该帧到画板</button></div>}
        {mediaError && <p className="vr-message is-error" role="alert">{mediaError}</p>}
        {draft.reference && <p className="vr-hint">{draft.reference.name} · {draft.reference.duration.toFixed(1)} 秒</p>}
        {draft.frameReference && <div className="vr-frame-reference">{framePreview && <img src={framePreview} alt="首帧生成参考图" />}<div><strong>已选参考帧</strong><p>{videoTime(draft.frameReference.time)}</p><button disabled={busy} onClick={() => change({ frameReference: null })}>移除参考图</button></div></div>}
      </section>
      <section className="vr-step-content" aria-label={steps[step - 1]}>
        <h3>{steps[step - 1]}</h3>
        {error && <div className="vr-message is-error" role="alert">{error}{saveStatus === "保存失败" && <button onClick={() => void action(flush)}>重试保存</button>}</div>}
        {step === 1 && (draft.referenceId ? <><p className="vr-message">此任务已获取参考视频。</p><p className="vr-hint">{draft.shareText}</p><div className="vr-actions"><button className="is-primary" onClick={() => change({ step: 2 })}>继续分析视频</button></div></> : <>
          <div className="vr-source-tabs" role="group" aria-label="获取途径">{([["douyin", "抖音链接"], ["local", "本地视频"], ["library", "素材库"]] as const).map(([id, name]) => <button key={id} disabled={busy} aria-pressed={draft.sourceMethod === id} onClick={() => { localStorage.setItem(sourceKey,id); change({ sourceMethod: id }); }}>{name}</button>)}</div>
          {draft.sourceMethod === "douyin" && <DouyinReferencePicker projectId={props.projectId} caseId={draft.id} shareText={draft.shareText} onShareText={shareText => change({ shareText })} ensureProject={flush} onUse={reference => void action(() => useReference(reference))} />}
          {draft.sourceMethod === "local" && <div className="vr-actions"><button disabled={busy} className="is-primary" onClick={() => void action(async () => { const path = await open({ multiple: false, filters: [{ name: "视频", extensions: ["mp4","mov","m4v","webm","mkv","avi"] }] }); if (typeof path === "string") await choose({ path }); })}>选择本地视频</button></div>}
          {draft.sourceMethod === "library" && <div className="vr-library-picker"><label className="vr-field">搜索视频<input value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>{sources.map(asset => <button disabled={busy} key={asset.id} onClick={() => void action(() => choose({ assetId: asset.id }))}>{asset.name}</button>)}{!sources.length && <p className="vr-hint">没有匹配的视频</p>}<div className="vr-actions"><button disabled={!offset} onClick={() => setOffset(Math.max(0,offset-40))}>上一页</button><button disabled={sources.length < 40} onClick={() => setOffset(offset+40)}>下一页</button></div></div>}
        </>)}
        {step === 2 && <><label className="vr-field">分析文本<textarea aria-label="分析文本" rows={16} value={draft.analysisText || ""} disabled={busy || running} onChange={e => change({ analysisText: e.target.value })} placeholder="点击分析视频，结果将填写在这里" maxLength={50000} /></label>
          <div className="vr-actions">{draft.appliedAnalysisId ? <><button className="is-primary" disabled={busy || running || !draft.analysisText?.trim()} onClick={() => change({ step: 3 })}>进行改写</button><button disabled={busy || running || !capability?.available || !media} onClick={() => void action(() => submit("analyze"))}>重新分析{price}</button></> : <button className="is-primary" disabled={busy || running || !capability?.available || !media} onClick={() => void action(() => submit("analyze"))}>分析视频{price}</button>}</div></>}
        {step === 3 && <>
          <label className="vr-field">改写方向<textarea aria-label="改写方向" rows={4} value={draft.rewriteDirection || ""} maxLength={8000} disabled={busy || running} onChange={e => change({ rewriteDirection: e.target.value })} placeholder="希望保留什么、改变什么？" /></label>
          <label className="vr-field">人设<textarea aria-label="人设" rows={2} value={draft.persona || ""} maxLength={8000} disabled={busy || running} onChange={e => change({ persona: e.target.value })} /></label>
          <label className="vr-field">改写规范<textarea aria-label="改写规范" rows={5} value={draft.rules || ""} maxLength={16000} disabled={busy || running} onChange={e => change({ rules: e.target.value })} /></label>
          <div className="vr-actions"><button className="is-primary" disabled={busy || running || !capability?.available || !draft.analysisText?.trim() || !draft.persona?.trim() || !draft.rules?.trim() || !media} onClick={() => void action(() => submit("rewrite"))}>开始改写{price}</button></div></>}
        {step === 4 && <><label className="vr-field">改写结果<textarea aria-label="改写结果" rows={12} maxLength={50000} disabled={busy} value={draft.rewrittenText || ""} onChange={e => change({ rewrittenText: e.target.value })} /></label>
          <label className="vr-field">首帧画面提示词<textarea aria-label="首帧画面提示词" rows={6} maxLength={12000} disabled={busy} value={draft.firstFramePrompt || ""} onChange={e => change({ firstFramePrompt: e.target.value })} /></label>
          {!draft.firstFramePrompt?.trim() && <p className="vr-hint">未识别到首帧提示词，可补写或从模型原文粘贴。</p>}
          <div className="vr-actions"><button className="is-primary" disabled={busy || !props.onCreateWorkflow || !draft.firstFramePrompt?.trim() || !draft.rewrittenText?.trim()} onClick={() => void action(workflow)}>生成工作流</button></div>
          <p className="vr-hint">建立四张相连卡片：首帧生成 → 图片内容列 → 视频生成 → 视频内容列。填好提示词与参考图，暂不运行。</p>
        </>}
        {(step === 2 || step === 3) && <><p className="vr-hint" role="status">{running ? job?.message || "正在处理…" : caps.loading ? "正在读取 Cloud 价格…" : caps.error ? "价格读取失败" : capability?.available ? `Bowerbird Cloud · ${capability.credits} 积分 / 次` : "服务暂不可用"}</p>
          {(caps.error || !caps.loading && !capability?.available) && <div className="vr-actions"><span role="alert">{caps.error}</span><button onClick={caps.refresh}>重新读取 Cloud 状态</button></div>}
          {job?.error && <p className="vr-message is-error" role="alert">{job.error}</p>}
          {job && ["failed","interrupted"].includes(job.state) && <button disabled={busy} onClick={() => void action(async () => { const result = await call<ReplicationTask>(props.projectId,"resume",{ id: job.id }); onUpdate({ ...initial, ...(step === 2 ? { analysisJob: result } : { rewriteJob: result }) }); })}>恢复原任务</button>}
        </>}
        {(analysisJob?.analysis || rewriteJob?.rewriteOriginalText) && step > 1 && <details className="vr-original"><summary>查看模型原文</summary><pre className="vr-payload">{step === 4 ? rewriteJob?.rewriteOriginalText : analysisJob?.analysis}</pre></details>}
      </section>
    </div>
  </ModalShell>;
}
