import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Copy, Merge, Minus, Plus, RotateCcw, Undo2 } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { ShotBoardDelivery, type ShotDeliveryRow } from "./ShotBoardDelivery";
import { ShotAnalysisAction, useShotJobs } from "./videoShots/ShotAnalysisControls";
import { ShotFrame, shotFrameLoader } from "./videoShots/ShotFrame";
import { alignShotSpeech, affectedShots, segments, shotStamp as stamp, type Shot, type ShotTexts, type Cut, type ShotChange, type ShotPlan } from "../lib/videoShots";
import type { VideoTranscript } from "../lib/videoTranscript";
import { userErrorMessage } from "../lib/userError";
import { notifyError } from "../lib/notify";
import "./LibraryVideoReplication.css";

type Props = { video: HTMLVideoElement | null; assetId: string; currentProjectId: string | null; onBack: () => void; onSeek: (seconds: number) => void; onTranscript: () => void; onOpenBoard: () => void };
type CutChange = { title: string; cuts: Cut[]; focus?: number; seekTo?: number; message?: string; undo?: boolean; rejectAt?: number; threshold?: number; restoreFocus?: boolean };
type Proposed = CutChange & { revision: number; affected: Shot[] };
type Delivery = { mode: "note" | "workflow"; rows: ShotDeliveryRow[] };
type CutDrag = { at: number; current: number; pointer: number; offset: number; lastSeek: number };
const labels = ["画面与运镜描述", "首帧生图提示词", "视频动态／运镜提示词"];
const cutLabels = { scene: "硬切", manual: "手动切点", long: "长镜分段" };
const saveDelay = 400;
const dragSeekInterval = 70;

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
  if (!plan) return <section className="shot-review shot-review-loading" aria-label="复刻">
    <button type="button" className="asset-detail-back" onClick={props.onBack}><ArrowLeft size={15}/>返回分析</button>
    <h3>逐镜复刻</h3><p role="status">{error || "正在读取镜头方案…"}</p>
    {error && <button type="button" className="app-button-secondary" onClick={() => void refresh()}>重试</button>}
  </section>;
  return <Editor key={`${props.assetId}:${plan.sourceHash}`} {...props} draft={plan} loadError={error} refresh={refresh} publish={setPlan}/>;
}

function Editor({assetId, currentProjectId, video,onBack,onSeek,onOpenBoard,onTranscript, draft,loadError,refresh,publish}: Props & {
  draft: ShotPlan; loadError: string; refresh: () => Promise<void>; publish: (plan: ShotPlan) => void;
}) {
  const [threshold,setThreshold] = useState(draft.threshold);
  const [activeCut,setActiveCut] = useState<number>();
  const [dragging,setDragging] = useState<{at:number; current:number}>();
  const drag = useRef<CutDrag>();
  const [focusCut,setFocusCut] = useState<number>();
  const [playhead,setPlayhead] = useState(0);
  const [notice,setNotice] = useState("");
  const [transcript,setTranscript] = useState<VideoTranscript | null>();
  const [confirmation,setConfirmation] = useState<Proposed>();
  const [delivery,setDelivery] = useState<Delivery>();
  const [copied,setCopied] = useState("");
  const [changing,setChanging] = useState(false), [detecting,setDetecting] = useState(false);
  const [detected,setDetected] = useState(draft.hardCutsDetected);
  const operation = useRef(false);
  const [edits,setEdits] = useState<Record<string, ShotTexts>>({});
  const [saving,setSaving] = useState(false);
  const [saveError,setSaveError] = useState("");
  const pending = useRef(new Map<string, ShotTexts>());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const inFlight = useRef<Promise<boolean>>();
  const latest = useRef(draft);
  if (draft.revision > latest.current.revision) latest.current = draft;
  const alive = useRef(true);
  const track = useRef<HTMLDivElement>(null);
  const loadFrame = useMemo(() => shotFrameLoader(assetId,draft.sourceHash),[assetId,draft.sourceHash]);
  const jobs = useShotJobs(assetId, draft.sourceHash, refresh);
  const locked = changing || jobs.locked;
  const pendingEdits = Object.keys(edits).length > 0;
  const detectionLabel = detected || draft.hardCutsDetected ? "重新检测" : "检测硬切";
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
  const analyzed = shots.filter(s => draft.results[s.id]);
  const currentJob = jobs.progress?.status === "running" ? jobs.progress.remaining[0] : undefined;
  useEffect(() => {
    let live = true;
    void invoke<VideoTranscript|null>("video_transcript_get",{assetId}).then(t => { if (live) setTranscript(t); })
      .catch(e => { if (live) { setTranscript(null); setNotice(userErrorMessage(e,"无法读取转录文稿，请重新打开。")); } });
    return () => { live = false; };
  },[assetId]);
  useEffect(() => {
    const sync = () => { if (video) setPlayhead(Math.round(video.currentTime * 1000)); };
    sync(); video?.addEventListener("timeupdate",sync); video?.addEventListener("seeked",sync);
    return () => { video?.removeEventListener("timeupdate",sync); video?.removeEventListener("seeked",sync); };
  },[video]);
  const write = useCallback(async (change: ShotChange, revision: number) => {
    const next = await invoke<ShotPlan>("video_shots_update",{assetId,sourceHash:draft.sourceHash,revision,change});
    if (next.revision >= latest.current.revision) {
      latest.current = next;
      if (alive.current) publish(next);
    }
  }, [assetId, draft.sourceHash, publish]);

  const flushEdits = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (inFlight.current) return inFlight.current;
    if (!pending.current.size) return Promise.resolve(true);
    if (alive.current) { setSaving(true); setSaveError(""); }
    const save = async () => {
      try {
        while (pending.current.size && !saveTimer.current) {
          const [id,texts] = pending.current.entries().next().value!;
          await write({type:"edit",id,texts},latest.current.revision);
          if (pending.current.get(id) === texts) pending.current.delete(id);
          if (alive.current) setEdits(Object.fromEntries(pending.current));
        }
        return true;
      } catch (failure) {
        if (alive.current) {
          setSaveError(userErrorMessage(failure,"镜头编辑未保存，请重试。"));
          await refresh();
        } else {
          notifyError(failure,"镜头编辑未保存，请重试。");
        }
        return false;
      } finally {
        inFlight.current = undefined;
        if (alive.current) setSaving(false);
      }
    };
    inFlight.current = save();
    return inFlight.current;
  }, [refresh, write]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; void flushEdits(); };
  }, [flushEdits]);
  useEffect(() => { void flushEdits(); }, [active.id, flushEdits]);
  useLayoutEffect(() => {
    if (focusCut === undefined || locked) return;
    track.current?.querySelector<HTMLButtonElement>(`[data-cut-at="${focusCut}"]`)?.focus({ preventScroll: true });
    setFocusCut(undefined);
  }, [draft.cuts, focusCut, locked]);

  async function withSavedEdits(action: () => Promise<void>, fallback = "镜头方案未保存，请核对后重试。") {
    if (operation.current || jobs.locked) return;
    operation.current = true;
    setChanging(true);
    try {
      if (!await flushEdits() || !alive.current) return;
      setNotice("");
      await action();
    } catch (e) {
      if (alive.current) {
        setNotice(userErrorMessage(e,fallback));
        await refresh();
      }
    } finally {
      operation.current = false;
      if (alive.current) setChanging(false);
    }
  }
  function seek(time:number) { setPlayhead(time); onSeek(time / 1000); }
  function normalize(time:number) { return Math.max(frameMs,Math.min(totalMs - frameMs,Math.round(time))); }
  async function commitChange(proposal: Proposed) {
    if (proposal.revision !== latest.current.revision) throw new Error("分镜已更新，请重新确认切点改动");
    const confirmed = proposal.affected.map(s => s.id);
    await write(proposal.undo ? {type:"undo",confirmed} :
      {type:"cuts",cuts:proposal.cuts,confirmed,suppressedAt:proposal.rejectAt,threshold:proposal.threshold}, proposal.revision);
    if (!alive.current) return;
    setActiveCut(proposal.focus);
    if (proposal.seekTo != null) seek(proposal.seekTo);
    if (proposal.restoreFocus) setFocusCut(proposal.focus);
    setNotice(proposal.message ?? "");
  }
  async function proposeChange(change: CutChange) {
    const base = latest.current;
    const cuts = [...change.cuts].sort((a,b) => a.at - b.at);
    if (!change.undo && change.threshold == null && JSON.stringify(cuts) === JSON.stringify(base.cuts)) return;
    const proposal = {...change, cuts, revision:base.revision, affected:affectedShots(base,cuts)};
    if (proposal.affected.length) setConfirmation(proposal); else await commitChange(proposal);
  }
  function requestChange(change: CutChange) {
    void withSavedEdits(() => proposeChange(change));
  }
  function cancelChange() {
    if (confirmation?.restoreFocus) setFocusCut(confirmation.rejectAt);
    setConfirmation(undefined);
  }
  function addCut() {
    const at = normalize(video && !video.paused ? video.currentTime * 1000 : playhead);
    if (draft.cuts.some(c => c.at === at)) { setNotice("此处已有切点"); return; }
    requestChange({title:"新增切点",cuts:[...draft.cuts,{at,kind:"manual"}],focus:at,seekTo:at});
  }
  function removeCut(at:number,title:string) { requestChange({title,cuts:draft.cuts.filter(c => c.at !== at),rejectAt:at}); }
  function clampCut(old:number,next:number) {
    const i = draft.cuts.findIndex(c => c.at === old);
    return Math.max(bounds[i]+frameMs,Math.min(bounds[i+2]-frameMs,normalize(next)));
  }
  function dragPosition(cut: CutDrag, x: number) {
    const rect = track.current?.getBoundingClientRect();
    return rect?.width ? clampCut(cut.at, (x - rect.left - cut.offset) * totalMs / rect.width) : cut.current;
  }
  function endDrag() { drag.current = undefined; setDragging(undefined); }
  function moveCut(old:number,next:number,restoreFocus = false) {
    const at = clampCut(old,next);
    if (at !== old) requestChange({title:"移动切点",cuts:draft.cuts.map(c => c.at === old ? {at,kind:"manual"} : c),focus:at,seekTo:at,rejectAt:old,restoreFocus});
  }
  function detect() {
    void withSavedEdits(async () => {
      setDetecting(true);
      try {
        const cuts = await invoke<Cut[]>("video_shots_detect",{assetId,sourceHash:draft.sourceHash,revision:latest.current.revision,threshold});
        if (!alive.current) return;
        setDetected(true);
        await proposeChange({title:detectionLabel,cuts,threshold,message:"检测到 " + cuts.filter(c => c.kind === "scene").length + " 个硬切"});
      } finally {
        if (alive.current) setDetecting(false);
      }
    }, "切点检测失败，请检查原件后重试。");
  }
  function select(selected:string[]) { void withSavedEdits(() => write({type:"select",selected},latest.current.revision)); }
  function toggle(id:string) { select(selected.has(id) ? draft.selected.filter(s => s !== id) : [...draft.selected,id]); }
  function deliver(mode: Delivery["mode"]) {
    void withSavedEdits(async () => {
      const saved = latest.current;
      const rows = wanted.flatMap(shot => {
        const texts = saved.results[shot.id];
        return texts ? [{ ...shot, texts, speech: speech.get(shot.id)?.text ?? "" }] : [];
      });
      if (!rows.length || rows.length !== wanted.length) throw new Error("请先完成所选镜头的分析");
      setDelivery({mode, rows});
    });
  }
  function leave(action: () => void) { void flushEdits().then(saved => { if (saved && alive.current) action(); }); }
  function edit(index:number,value:string) {
    if (!result || operation.current || jobs.locked) return;
    const texts: ShotTexts = [...(pending.current.get(active.id) ?? result)];
    texts[index] = value;
    pending.current.set(active.id,texts);
    setEdits(Object.fromEntries(pending.current));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushEdits(),saveDelay);
  }
  async function copy(index:number,value:string) {
    try { await navigator.clipboard.writeText(value); setCopied(active.id + index); }
    catch { setNotice("无法复制，可在输入框内选择文本"); }
  }
  return <section className="shot-review" aria-label="复刻">
    <header className="shot-review-head">
      <button type="button" className="asset-detail-back" onClick={() => leave(onBack)}><ArrowLeft size={15} aria-hidden="true"/>返回分析</button>
      <div className="shot-review-heading">
        <h3>逐镜复刻</h3>
        <span className="shot-meta">{shots.length} 镜 · 已分析 {analyzed.length}</span>
        <button type="button" className="app-button-secondary" disabled={!draft.canUndo || locked}
          onClick={() => { if (draft.undoCuts) requestChange({ title: "撤销切点改动", cuts: draft.undoCuts, undo: true, message: "已撤销上一步切点改动" }); }}><Undo2 size={14} aria-hidden="true"/>撤销切点改动</button>
      </div>
    </header>
    <div className="shot-review-body">
    <section className="shot-review-section" aria-label="切点与镜头">
      <div className="shot-tool-row">
        <h4>切点</h4>
        <button type="button" className="app-button-secondary" onClick={detect} disabled={locked}><RotateCcw size={13} aria-hidden="true"/>{detecting ? "正在检测…" : detectionLabel}</button>
        <label className="shot-threshold">检测阈值
          <input type="range" min="0.15" max="0.95" step="0.01" value={threshold}
            disabled={locked} onChange={event => setThreshold(Number(event.target.value))}/>
          <output>{threshold.toFixed(2)}</output>
        </label>
      </div>
      <div className="shot-cut-legend" aria-label="切点来源">
        {(Object.keys(cutLabels) as Cut["kind"][]).map(kind => <span key={kind}><i data-kind={kind} aria-hidden="true"/>{cutLabels[kind]}</span>)}
      </div>
      <div ref={track} className="shot-timeline">
        <div className="shot-timeline-film" aria-hidden="true">{film.map((s,i) => <span key={s.id} style={{ flexGrow: (film[i+1]?.start ?? totalMs) - s.start, flexBasis: 0 }}><ShotFrame load={loadFrame} start={s.start}/></span>)}</div>
        <input aria-label="复刻播放头" type="range" min={0} max={totalMs} step={frameMs} value={Math.min(totalMs, dragging?.current ?? playhead)}
          onChange={event => seek(Number(event.target.value))}/>
        {draft.cuts.map(cut => <button key={cut.at} className="shot-cut" data-kind={cut.kind} data-cut-at={cut.at} type="button"
          style={{ left: ((dragging?.at === cut.at ? dragging.current : cut.at) / totalMs * 100) + "%" }}
          aria-label={`${cutLabels[cut.kind]} ${stamp(cut.at)}`} title={`${cutLabels[cut.kind]} ${stamp(cut.at)}`}
          aria-pressed={activeCut === cut.at} disabled={locked}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const step = event.shiftKey ? 33 : 100;
            moveCut(cut.at, cut.at + (event.key === "ArrowLeft" ? -step : step), true);
          }}
          onPointerDown={event => {
            if (event.button !== 0 || drag.current || locked) return;
            const rect = track.current?.getBoundingClientRect();
            if (!rect?.width) return;
            const offset = event.clientX - (rect.left + rect.width * cut.at / totalMs);
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { at: cut.at, current: cut.at, pointer: event.pointerId, offset, lastSeek: -Infinity };
            setActiveCut(cut.at);
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (current?.pointer !== event.pointerId || locked) return;
            const at = dragPosition(current, event.clientX);
            if (at === current.current) return;
            current.current = at;
            setDragging({ at: cut.at, current: at });
            const now = performance.now();
            if (now - current.lastSeek >= dragSeekInterval) {
              current.lastSeek = now;
              seek(at);
            }
          }}
          onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) endDrag(); }}
          onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) endDrag(); }}
          onPointerUp={event => {
            const current = drag.current;
            if (current?.pointer !== event.pointerId) return;
            const at = dragPosition(current, event.clientX);
            endDrag();
            if (locked) return;
            seek(at);
            moveCut(cut.at, at);
          }}
          onClick={event => { if (event.detail === 0) { setActiveCut(cut.at); seek(cut.at); } }}/>
        )}
      </div>
      <div className="shot-timestamps shot-meta"><span>0:00</span><output>{stamp(dragging?.current ?? playhead)}</output><span>{stamp(totalMs).replace(/\.000$/, "")}</span></div>
      <div className="shot-tool-row" role="group" aria-label="切点操作">
        <button type="button" className="app-button-secondary" disabled={locked || playhead < frameMs || playhead >= totalMs - frameMs} onClick={addCut}><Plus size={14} aria-hidden="true"/>在播放头添加切点</button>
        <button type="button" className="app-button-secondary" disabled={activeCut == null || locked} onClick={() => { if (activeCut != null) removeCut(activeCut, "删除切点"); }}><Minus size={14} aria-hidden="true"/>删除切点</button>
        <button type="button" className="app-button-secondary" disabled={active.end >= totalMs || locked} onClick={() => removeCut(active.end, "合并镜头")}><Merge size={14} aria-hidden="true"/>与下一镜合并</button>
      </div>
      <div className="shot-tool-row shot-analysis-action">
        <h4>镜头</h4>
        <ShotAnalysisAction assetId={assetId} sourceHash={draft.sourceHash} revision={draft.revision} shots={chargeable} jobs={jobs} disabled={changing} pendingEdits={pendingEdits}/>
      </div>
      <div className="shot-strip" aria-label="镜头选择">
        {shots.map(shot => <article key={shot.id} className={shot.id === active.id ? "is-current" : ""}>
          <button type="button" aria-label={`查看镜头 ${shot.index + 1}`} aria-pressed={shot.id === active.id}
            onClick={() => { setActiveCut(shot.start || undefined); seek(shot.start); }}>
            <ShotFrame load={loadFrame} start={shot.start}/><strong>镜头 {String(shot.index + 1).padStart(2, "0")}</strong>
            <span className="shot-meta">{stamp(shot.start)}–{stamp(shot.end)}</span>
          </button>
          <label><input type="checkbox" aria-label={`勾选镜头 ${shot.index + 1}`} checked={selected.has(shot.id)}
            disabled={locked} onChange={() => toggle(shot.id)}/>{currentJob === shot.id ? "分析中" : draft.results[shot.id] ? "已分析" : "待分析"}</label>
        </article>)}
      </div>
    </section>
    <section className="shot-review-section shot-detail" aria-label="镜头详情">
      <div className="shot-tool-row">
        <h4>镜头 {String(active.index + 1).padStart(2, "0")}</h4>
        <span className="shot-meta">{stamp(active.start)}–{stamp(active.end)} · {((active.end - active.start) / 1000).toFixed(2)} 秒</span>
        {result && <ShotAnalysisAction key={active.id} assetId={assetId} sourceHash={draft.sourceHash} revision={draft.revision} shots={[active]} jobs={jobs} rerun disabled={changing} pendingEdits={pendingEdits}/>}
      </div>
      <div className="shot-evidence">
        <ShotFrame load={loadFrame} start={active.start} label="当前镜头首帧"/>
        <div><h5>真实台词</h5>
          {activeSpeech?.text ? <p>{activeSpeech?.text}{activeSpeech.legacy && <small> · 句级时间</small>}</p> : transcript?.status === "completed" || transcript?.status === "no_speech" || transcript?.status === "no_audio"
            ? <p>此镜头无台词</p> : transcript === undefined ? <p role="status">正在读取文稿…</p>
              : <button type="button" className="app-button-secondary" onClick={() => leave(onTranscript)}>转录文稿</button>}
        </div>
      </div>
      <div className="shot-fields">
        {labels.map((label, index) => <div key={label}>
          <div className="shot-field-title"><label htmlFor={"video-shot-" + index}>{label}</label>
            <button type="button" className="asset-detail-icon-button" aria-label={`复制${label}`} title={copied === active.id + index ? "已复制" : `复制${label}`}
              disabled={!result?.[index]} onClick={() => { if (result) void copy(index, result[index]); }}><Copy size={13} aria-hidden="true"/></button>
          </div>
          <textarea id={"video-shot-" + index} rows={4} value={result?.[index] ?? ""} readOnly={!result || jobs.locked || changing}
            placeholder="待分析" onChange={event => edit(index, event.target.value)} onBlur={() => void flushEdits()}/>
        </div>)}
      </div>
      {pendingEdits && <div className="shot-save-status" role={saveError ? "alert" : "status"}>
        {saveError || (saving ? "正在保存提示词…" : "提示词待保存")}
        {saveError && <button type="button" className="app-button-secondary" onClick={() => void flushEdits()}>重新保存</button>}
      </div>}
    </section>
    {notice && <p role="status">{notice}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    </div>
    <footer className="shot-delivery">
      <div className="shot-delivery-selection">
        <p className="shot-meta" role="status">已勾选 {wanted.length} 镜 · 待分析 {chargeable.length} 镜</p>
        <div className="shot-tool-row shot-quick-select" role="group" aria-label="快捷勾选">
          <button type="button" className="asset-detail-back" disabled={locked || wanted.length === shots.length} onClick={() => select(shots.map(s => s.id))}>全选</button>
          <button type="button" className="asset-detail-back" disabled={locked || !wanted.length} onClick={() => select([])}>取消全选</button>
          <button type="button" className="asset-detail-back" disabled={locked || analyzed.length === shots.length} onClick={() => select(shots.filter(s => !draft.results[s.id]).map(s => s.id))}>仅选待分析</button>
          <button type="button" className="asset-detail-back" disabled={locked || !analyzed.length} onClick={() => select(analyzed.map(s => s.id))}>仅选已分析</button>
        </div>
      </div>
      <div className="shot-delivery-actions">
        <button type="button" className="app-button-secondary" disabled={locked || !wanted.length || !!chargeable.length} onClick={() => deliver("note")}>生成画板分镜卡</button>
        <button type="button" className="app-button-primary" disabled={locked || !wanted.length || !!chargeable.length} onClick={() => deliver("workflow")}>生成画板分镜工作流</button>
      </div>
    </footer>
    {confirmation && <ModalShell title={`确认${confirmation.title}`} onClose={cancelChange} footer={<>
      <button type="button" className="app-modal-button" data-modal-autofocus onClick={cancelChange}>取消</button>
      <button type="button" className="app-modal-button is-danger" disabled={locked} onClick={() => {
        setConfirmation(undefined);
        void withSavedEdits(() => commitChange(confirmation));
      }}>确认{confirmation.title}</button>
    </>}>
      <p>将清除以下镜头的分析结果和手动编辑。</p>
      <ul className="shot-affected">{confirmation.affected.map(shot =>
        <li key={shot.id}>镜头 {String(shot.index + 1).padStart(2, "0")} · {stamp(shot.start)}–{stamp(shot.end)}</li>)}</ul>
    </ModalShell>}
    {delivery && <ShotBoardDelivery {...delivery} assetId={assetId} sourceHash={draft.sourceHash} currentProjectId={currentProjectId} onOpenBoard={onOpenBoard} onClose={() => setDelivery(undefined)}/>}
  </section>;
}
