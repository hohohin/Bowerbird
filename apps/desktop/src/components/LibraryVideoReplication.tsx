import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Copy, Merge, Minus, Plus, RotateCcw, Undo2 } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { ShotBoardDelivery } from "./ShotBoardDelivery";
import { ShotAnalysisAction, useShotJobs } from "./videoShots/ShotAnalysisControls";
import { ShotFrame, shotFrameLoader } from "./videoShots/ShotFrame";
import { alignShotSpeech, affectedShots, segments, shotStamp as stamp, type Shot, type ShotTexts, type Cut, type ShotChange, type ShotPlan } from "../lib/videoShots";
import type { VideoTranscript } from "../lib/videoTranscript";
import { userErrorMessage } from "../lib/userError";
import { notifyError } from "../lib/notify";
import "./LibraryVideoReplication.css";

type Props = { video: HTMLVideoElement | null; assetId: string; currentProjectId: string | null; onBack: () => void; onSeek: (seconds: number) => void; onTranscript: () => void; onOpenBoard: () => void };
type CutChange = { title: string; cuts: Cut[]; focus?: number; seekTo?: number; message?: string; undo?: boolean; rejectAt?: number; threshold?: number };
type Proposed = CutChange & { revision: number; affected: Shot[] };
const labels = ["画面与运镜描述", "首帧生图提示词", "视频动态／运镜提示词"];

export function LibraryVideoReplication(props: Props) {
  const [plan,setPlan] = useState<ShotPlan>();
  const [error,setError] = useState("");
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++seq.current;
    try {
      const next = await invoke<ShotPlan>("video_shots_get",{assetId:props.assetId});
      if (id === seq.current) { setPlan(previous => previous?.sourceHash === next.sourceHash && previous.revision > next.revision ? previous : next); setError(""); }
    } catch (failure) { if (id === seq.current) setError(userErrorMessage(failure,"无法读取镜头方案，请重试。")); }
  },[props.assetId]);
  useEffect(() => { void refresh(); return () => { seq.current++; }; },[refresh]);
  if (!plan || error) return <section className="shot-review" aria-label="复刻">
    <button type="button" className="asset-detail-back" onClick={props.onBack}><ArrowLeft size={15}/>返回分析</button>
    <h3>复刻</h3><p role="status">{error || "正在读取镜头方案…"}</p>
    {error && <button type="button" className="app-button-secondary" onClick={() => void refresh()}>重试</button>}
  </section>;
  return <Editor key={plan.sourceHash} {...props} draft={plan} refresh={refresh} publish={setPlan}/>;
}

function Editor({assetId, currentProjectId, video,onBack,onSeek,onOpenBoard,onTranscript, draft,refresh,publish}: Props & {
  draft: ShotPlan; refresh: () => Promise<void>; publish: (plan: ShotPlan) => void;
}) {
  const [threshold,setThreshold] = useState(draft.threshold);
  const [activeCut,setActiveCut] = useState<number>();
  const [dragging,setDragging] = useState<{previous:number; current:number}>();
  const [playhead,setPlayhead] = useState(0);
  const [notice,setNotice] = useState("");
  const [transcript,setTranscript] = useState<VideoTranscript | null>();
  const [confirmation,setConfirmation] = useState<Proposed>();
  const [delivery,setDelivery] = useState<"note" | "workflow">();
  const [copied,setCopied] = useState("");
  const [changing,setChanging] = useState(false), [detecting,setDetecting] = useState(false);
  const [edits,setEdits] = useState<Record<string, ShotTexts>>({});
  const pending = useRef(new Map<string, ShotTexts>()), saving = useRef(false);
  const latest = useRef(draft);
  if (draft.revision > latest.current.revision) latest.current = draft;
  const alive = useRef(true);
  const track = useRef<HTMLDivElement>(null);
  const loadFrame = useMemo(() => shotFrameLoader(assetId,draft.sourceHash),[assetId,draft.sourceHash]);
  const jobs = useShotJobs(assetId, draft.sourceHash, refresh);
  const busy = changing || detecting || !!Object.keys(edits).length;
  const locked = busy || jobs.locked;
  const totalMs = draft.durationMs, frameMs = 1;
  const shots = useMemo(() => segments(draft.cuts,totalMs),[draft.cuts,totalMs]);
  const film = useMemo(() => shots.length <= 16 ? shots : Array.from({length:16},(_,i) =>
    shots.find(s => s.end > i * totalMs / 16) ?? shots[shots.length - 1]).filter((s,i,list) => i === 0 || s.id !== list[i-1].id),[shots,totalMs]);
  const bounds = [0,...draft.cuts.map(c => c.at),totalMs];
  const active = shots.find(s => s.end > playhead) ?? shots[shots.length-1];
  const selected = new Set(draft.selected);
  const wanted = shots.filter(s => selected.has(s.id));
  const chargeable = wanted.filter(s => !draft.results[s.id]);
  const result = edits[active.id] ?? draft.results[active.id];
  const speech = useMemo(() => alignShotSpeech(shots, transcript),[shots,transcript]);
  const activeSpeech = speech.get(active.id);
  const rows = wanted.flatMap(s => draft.results[s.id] ? [{...s,texts:draft.results[s.id],speech:speech.get(s.id)?.text ?? ""}] : []);
  const currentJob = jobs.progress?.status === "running" ? jobs.progress.remaining[0] : undefined;
  useEffect(() => {
    alive.current = true;
    let live = true;
    void invoke<VideoTranscript|null>("video_transcript_get",{assetId}).then(t => { if (live) setTranscript(t); })
      .catch(e => { if (live) { setTranscript(null); setNotice(userErrorMessage(e,"无法读取转录文稿，请重新打开。")); } });
    return () => { live = false; alive.current = false; };
  },[assetId]);
  useEffect(() => {
    const sync = () => { if (video) setPlayhead(Math.round(video.currentTime * 1000)); };
    sync(); video?.addEventListener("timeupdate",sync); video?.addEventListener("seeked",sync);
    return () => { video?.removeEventListener("timeupdate",sync); video?.removeEventListener("seeked",sync); };
  },[video]);
  async function write(change: ShotChange, revision: number) {
    const next = await invoke<ShotPlan>("video_shots_update",{assetId,sourceHash:draft.sourceHash,revision,change});
    if (next.revision >= latest.current.revision) {
      latest.current = next;
      if (alive.current) publish(next);
    }
  }
  async function mutate(change: ShotChange, revision: number) {
    setChanging(true);
    try { await write(change,revision); setNotice(""); return true; }
    catch (e) { setNotice(userErrorMessage(e,"镜头方案未保存，请核对后重试。")); await refresh(); return false; }
    finally { setChanging(false); }
  }
  function seek(time:number) { setPlayhead(time); onSeek(time / 1000); }
  function normalize(time:number) { return Math.max(frameMs,Math.min(totalMs - frameMs,Math.round(time))); }
  async function applyChange(proposal: Proposed) {
    setConfirmation(undefined);
    const confirmed = proposal.affected.map(s => s.id);
    const ok = await mutate(proposal.undo ? {type:"undo",confirmed} :
      {type:"cuts",cuts:proposal.cuts,confirmed,suppressedAt:proposal.rejectAt,threshold:proposal.threshold}, proposal.revision);
    if (ok) { setActiveCut(proposal.focus); if (proposal.seekTo != null) seek(proposal.seekTo); setNotice(proposal.message ?? ""); }
  }
  function requestChange(change: CutChange) {
    if (locked) return;
    change.cuts = [...change.cuts].sort((a,b) => a.at - b.at);
    if (JSON.stringify(change.cuts) === JSON.stringify(draft.cuts) && change.threshold == null) return;
    const proposal = {...change, revision:draft.revision, affected:affectedShots(draft,change.cuts)};
    if (proposal.affected.length) setConfirmation(proposal); else void applyChange(proposal);
  }
  function addCut() {
    const at = normalize(video && !video.paused ? video.currentTime * 1000 : playhead);
    if (draft.cuts.some(c => c.at === at)) { setNotice("此处已有切点"); return; }
    requestChange({title:"新增切点",cuts:[...draft.cuts,{at,kind:"manual"}],focus:at,seekTo:at});
  }
  function removeCut(at:number,title:string) { requestChange({title,cuts:draft.cuts.filter(c => c.at !== at),rejectAt:at}); }
  function moveCut(old:number,next:number) {
    const i = draft.cuts.findIndex(c => c.at === old);
    const at = Math.max(bounds[i]+frameMs,Math.min(bounds[i+2]-frameMs,normalize(next)));
    if (at !== old) requestChange({title:"移动切点",cuts:draft.cuts.map(c => c.at === old ? {at,kind:"manual"} : c),focus:at,seekTo:at,rejectAt:old});
  }
  async function detect() {
    setDetecting(true);
    try {
      const cuts = await invoke<Cut[]>("video_shots_detect",{assetId,sourceHash:draft.sourceHash,revision:draft.revision,threshold});
      if (alive.current) requestChange({title:"重新检测",cuts,threshold,message:"检测到 " + cuts.filter(c => c.kind === "scene").length + " 个硬切"});
    } catch (e) { setNotice(userErrorMessage(e,"切点检测失败，请检查原件后重试。")); }
    finally { setDetecting(false); }
  }
  function select({selected}: {selected:string[]}) { void mutate({type:"select",selected},draft.revision); }
  function toggle(id:string) { select({selected:selected.has(id) ? draft.selected.filter(s => s !== id) : [...draft.selected,id]}); }
  async function flushEdits() {
    if (saving.current) return;
    saving.current = true;
    try {
      while (pending.current.size) {
        const [id,texts] = pending.current.entries().next().value!;
        await write({type:"edit",id,texts},latest.current.revision);
        if (pending.current.get(id) === texts) pending.current.delete(id);
        if (alive.current) setEdits(Object.fromEntries(pending.current));
      }
    } catch (failure) {
      notifyError(failure,"镜头编辑未保存，请重试。");
      if (alive.current) { setNotice("镜头编辑未保存"); await refresh(); }
    } finally { saving.current = false; }
  }
  function edit(index:number,value:string) {
    if (!result || changing || jobs.locked) return;
    const texts: ShotTexts = [...(pending.current.get(active.id) ?? result)];
    texts[index] = value;
    pending.current.set(active.id,texts); setEdits(Object.fromEntries(pending.current)); void flushEdits();
  }
  async function copy(index:number,value:string) {
    try { await navigator.clipboard.writeText(value); setCopied(active.id + index); }
    catch { setNotice("无法复制，可在输入框内选择文本"); }
  }
  return <section className="shot-review" aria-label="复刻">
    <div className="shot-review-head">
      <button type="button" className="asset-detail-back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true"/>返回分析</button>
      <h3>复刻</h3>
    </div>
    <section className="shot-review-section" aria-label="切点微调">
      <div className="shot-tool-row">
        <label className="shot-threshold">检测阈值
          <input type="range" min="0.15" max="0.95" step="0.01" value={threshold}
            disabled={locked} onChange={event => setThreshold(Number(event.target.value))}/>
          <output>{threshold.toFixed(2)}</output>
        </label>
        <button type="button" className="app-button-secondary" onClick={detect} disabled={locked}><RotateCcw size={13} aria-hidden="true"/>{detecting ? "正在检测…" : "重新检测"}</button>
      </div>
      <div ref={track} className="shot-timeline">
        <div className="shot-timeline-film" aria-hidden="true">{film.map((s,i) => <span key={s.id} style={{ flexGrow: (film[i+1]?.start ?? totalMs) - s.start, flexBasis: 0 }}><ShotFrame load={loadFrame} start={s.start}/></span>)}</div>
        <input aria-label="复刻播放头" type="range" min={0} max={totalMs} step={frameMs} value={Math.min(totalMs, playhead)}
          onChange={event => seek(Number(event.target.value))}/>
        {draft.cuts.map(cut => <button key={cut.at} className="shot-cut" type="button"
          style={{ left: ((dragging?.previous === cut.at ? dragging.current : cut.at) / totalMs * 100) + "%" }}
          aria-label={`${cut.kind === "manual" ? "手动切点" : cut.kind === "long" ? "长镜分段" : "硬切"} ${stamp(cut.at)}`} title={stamp(cut.at)}
          aria-pressed={activeCut === cut.at} disabled={locked}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            moveCut(cut.at, cut.at + (event.key === "ArrowLeft" ? -frameMs : frameMs));
          }}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setDragging({ previous: cut.at, current: cut.at }); }}
          onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId) || !track.current) return;
            const rect = track.current.getBoundingClientRect();
            setDragging({ previous: cut.at, current: normalize((event.clientX - rect.left) * totalMs / rect.width) });
          }}
          onPointerCancel={() => setDragging(undefined)}
          onPointerUp={() => {
            if (dragging?.previous === cut.at && dragging.current !== cut.at) moveCut(cut.at, dragging.current);
            else { setActiveCut(cut.at); seek(cut.at); }
            setDragging(undefined);
          }}
          onClick={event => { if (event.detail === 0) { setActiveCut(cut.at); seek(cut.at); } }}/>
        )}
      </div>
      <div className="shot-timestamps"><span>0:00</span><output>{stamp(playhead)}</output><span>{stamp(totalMs).replace(/\.000$/, "")}</span></div>
      <div className="shot-tool-row" role="group" aria-label="切点操作">
        <button type="button" className="app-button-secondary" disabled={locked || playhead < frameMs || playhead >= totalMs - frameMs} onClick={addCut}><Plus size={14} aria-hidden="true"/>在播放头添加切点</button>
        <button type="button" className="app-button-secondary" disabled={activeCut == null || locked} onClick={() => { if (activeCut != null) removeCut(activeCut, "删除切点"); }}><Minus size={14} aria-hidden="true"/>删除切点</button>
        <button type="button" className="app-button-secondary" disabled={active.end >= totalMs || locked} onClick={() => removeCut(active.end, "合并镜头")}><Merge size={14} aria-hidden="true"/>与下一镜合并</button>
        <button type="button" className="app-button-secondary" disabled={!draft.canUndo || locked}
          onClick={() => { if (draft.undoCuts) requestChange({ title: "撤销切点改动", cuts: draft.undoCuts, undo: true, message: "已撤销上一步切点改动" }); }}><Undo2 size={14} aria-hidden="true"/>撤销上一步切点改动</button>
      </div>
    </section>
    <section className="shot-review-section" aria-label="镜头">
      <div className="shot-tool-row">
        <h4>镜头</h4>
        <span className="shot-count">已选 {wanted.length} 个</span>
        <ShotAnalysisAction assetId={assetId} sourceHash={draft.sourceHash} shots={chargeable} jobs={jobs} disabled={busy}/>
      </div>
      <div className="shot-tool-row shot-quick-select" role="group" aria-label="快捷勾选">
        <button type="button" className="app-button-secondary" disabled={locked} onClick={() => select({ selected: shots.map(s => s.id) })}>全选</button>
        <button type="button" className="app-button-secondary" disabled={locked} onClick={() => select({ selected: [] })}>取消全选</button>
        <button type="button" className="app-button-secondary" disabled={locked} onClick={() => select({ selected: shots.filter(s => !draft.results[s.id]).map(s => s.id) })}>仅选待分析</button>
      </div>
      <div className="shot-strip" aria-label="镜头选择">
        {shots.map(shot => <article key={shot.id} className={shot.id === active.id ? "is-current" : ""}>
          <button type="button" aria-label={`查看镜头 ${shot.index + 1}`} aria-pressed={shot.id === active.id}
            onClick={() => { setActiveCut(shot.start || undefined); seek(shot.start); }}>
            <ShotFrame load={loadFrame} start={shot.start}/><strong>镜头 {String(shot.index + 1).padStart(2, "0")}</strong>
            <span>{stamp(shot.start)}–{stamp(shot.end)}</span>
          </button>
          <label><input type="checkbox" aria-label={`勾选镜头 ${shot.index + 1}`} checked={selected.has(shot.id)}
            disabled={locked} onChange={() => toggle(shot.id)}/>{currentJob === shot.id ? "分析中" : draft.results[shot.id] ? "已分析" : "待分析"}</label>
        </article>)}
      </div>
    </section>
    <section className="shot-review-section shot-detail" aria-label="镜头详情">
      <div className="shot-tool-row"><h4>镜头 {String(active.index + 1).padStart(2, "0")}</h4><span>{stamp(active.start)}–{stamp(active.end)} · {((active.end - active.start) / 1000).toFixed(2)} 秒</span></div>
      <div className="shot-evidence">
        <ShotFrame load={loadFrame} start={active.start} label="当前镜头首帧"/>
        <div><h5>真实台词</h5>
          {activeSpeech?.text ? <p>{activeSpeech?.text}{activeSpeech.legacy && <small> · 句级时间</small>}</p> : transcript?.status === "completed" || transcript?.status === "no_speech" || transcript?.status === "no_audio"
            ? <p>此镜头无台词</p> : transcript === undefined ? <p role="status">正在读取文稿…</p>
              : <button type="button" className="app-button-secondary" onClick={onTranscript}>转录文稿</button>}
        </div>
      </div>
      <div className="shot-fields">
        {labels.map((label, index) => <div key={label}>
          <div className="shot-field-title"><label htmlFor={"video-shot-" + index}>{label}</label>
            <button type="button" className="asset-detail-icon-button" aria-label={`复制${label}`} title={copied === active.id + index ? "已复制" : `复制${label}`}
              disabled={!result?.[index]} onClick={() => { if (result) void copy(index, result[index]); }}><Copy size={13} aria-hidden="true"/></button>
          </div>
          <textarea id={"video-shot-" + index} rows={2} value={result?.[index] ?? ""} readOnly={!result || jobs.locked || changing} placeholder="待分析" onChange={event => edit(index, event.target.value)}/>
        </div>)}
      </div>
      {result && <ShotAnalysisAction key={active.id} assetId={assetId} sourceHash={draft.sourceHash} shots={[active]} jobs={jobs} rerun disabled={busy}/>}
    </section>
    {notice && <p role="status">{notice}{notice === "镜头编辑未保存" && <button type="button" className="app-button-secondary" onClick={() => void flushEdits()}>重新保存</button>}</p>}
    <div className="shot-delivery">
      {chargeable.length > 0 ? <p className="shot-delivery-hint" role="status">还有 {chargeable.length} 个选中镜头未分析，请先分析或取消勾选</p>
        : !wanted.length && <p className="shot-delivery-hint" role="status">请先勾选要发送的镜头</p>}
      {rows.length > 0 && chargeable.length > 0 && <button type="button" className="app-button-secondary" disabled={locked}
        onClick={() => select({selected:rows.map(row => row.id)})}>仅选已分析的 {rows.length} 个镜头</button>}
      <button type="button" className="app-button-secondary" disabled={busy || !rows.length || rows.length !== wanted.length} onClick={() => setDelivery("note")}>生成画板分镜卡</button>
      <button type="button" className="app-button-primary" disabled={busy || !rows.length || rows.length !== wanted.length} onClick={() => setDelivery("workflow")}>生成画板分镜工作流</button>
    </div>
    {confirmation && <ModalShell title={`确认${confirmation.title}`} onClose={() => setConfirmation(undefined)} footer={<>
      <button type="button" className="app-modal-button" data-modal-autofocus onClick={() => setConfirmation(undefined)}>取消</button>
      <button type="button" className="app-modal-button is-danger" onClick={() => void applyChange(confirmation)}>确认{confirmation.title}</button>
    </>}>
      <p>将清除以下镜头的分析结果和手动编辑。</p>
      <ul className="shot-affected">{confirmation.affected.map(shot =>
        <li key={shot.id}>镜头 {String(shot.index + 1).padStart(2, "0")} · {stamp(shot.start)}–{stamp(shot.end)}</li>)}</ul>
    </ModalShell>}
    {delivery && <ShotBoardDelivery mode={delivery} rows={rows} assetId={assetId} sourceHash={draft.sourceHash} currentProjectId={currentProjectId ?? null} onOpenBoard={onOpenBoard} onClose={() => setDelivery(undefined)}/>}
  </section>;
}
