import type { ReplicationAnalysisOutput } from "../lib/replicationAnalysisNote";
import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { replicationCall as call } from "./replicationTaskState";
import { useReplicationCapabilities } from "./useReplicationCapabilities";
import { VideoPlayer } from "./VideoPlayer";
import "./EnhancedReplication.css";
import { userErrorMessage } from "../lib/userError";
import { notifyError, notifySuccess } from "../lib/notify";

interface Prompt { index: number; prompt: string; duration: number }
interface Record {
  id: string; state?: string; message?: string; error?: string; resumeAction?: string;
  slices: { index: number; start: number; end: number; boundary: string }[];
  analysis?: { index: number; analysis: { analysisText?: string } }[];
  speech?: { text: string; utterances?: { text: string; startMs: number; endMs: number }[] }; prompts?: Prompt[]; frozenPrompts?: Prompt[]; outputPath?: string;
  markerEvents?: { id: string; status: string }[];
}
export function EnhancedReplication(props: { projectId: string; caseId: string; initialId?: string; persona: string; rules: string;
  onViewShot?: (time: number) => void;
  onAddAnalysis?: (output: ReplicationAnalysisOutput) => Promise<void>;
  direction: string; beforePrepare: () => Promise<void>; onPrepared: (id: string) => void; onAddVideo?: (path: string, operationId: string) => Promise<void> }) {
  const [selectedShot, setSelectedShot] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [frames, setFrames] = useState<{ [index: number]: { dataUrl: string; time: number } }>({});
  const [frameError, setFrameError] = useState(""), [frameRevision, setFrameRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const exportLock = useRef(false);
  const [record, setRecord] = useState<Record>();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [persona,setPersona] = useState(props.persona), [rules,setRules] = useState(props.rules), [direction,setDirection] = useState(props.direction);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), locked = useRef(false), loadedPrompts = useRef("");
  const caps = useReplicationCapabilities(props.projectId);
  const id = record?.id || props.initialId;
  const running = record?.state === "running";
  const available = (operation: string) => caps.services.some(s => s.operation === operation && s.available);
  const cost = (operation: string) => caps.services.find(s => s.operation === operation)?.credits ?? "—";
  function accept(value: Record) {
    if (!alive.current) return;
    setRecord(value);
    if (value.prompts && loadedPrompts.current !== value.id) { loadedPrompts.current = value.id; setPrompts(value.frozenPrompts || value.prompts); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!id) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try { const value = await call<Record>(props.projectId, "enhanced-get", { id }); if (!disposed) accept(value); }
      catch (e) { if (!disposed) setError(userErrorMessage(e, "读取强化复刻进度失败")); }
      finally { if (!disposed) timer = setTimeout(read, 2500); }
    }
    void read(); return () => { disposed = true; clearTimeout(timer); };
  }, [id, props.projectId]);
  const sliceCount = record?.slices.length || 0;
  useEffect(() => {
    if (!id || !record) return;
    let disposed = false;
    setFrameError("");
    void (async () => {
      for (const slice of record.slices) {
        if (disposed) return;
        try {
          const frame = await call<{ dataUrl: string; time: number }>(props.projectId, "enhanced-frame", { id, index: slice.index });
          if (!disposed) setFrames(current => ({ ...current, [slice.index]: frame }));
        } catch (e) { if (!disposed) setFrameError(userErrorMessage(e, "关键帧读取失败，请重试")); return; }
      }
    })();
    return () => { disposed = true; };
  }, [id, props.projectId, sliceCount, frameRevision]);
  async function addAnalysis() {
    if (!record || !props.onAddAnalysis || exportLock.current || !selected.length) return;
    exportLock.current = true; setExporting(true);
    try {
      const rows = record.slices.filter(s => selected.includes(s.index)).map(slice => {
        const text = record.analysis?.find(a => a.index === slice.index)?.analysis.analysisText;
        if (!text?.trim() || !frames[slice.index]) throw new Error("请等待所选镜头的分析与关键帧准备完成");
        const speech = record.speech?.utterances?.filter(u => u.endMs > slice.start * 1000 && u.startMs < slice.end * 1000).map(u => u.text).join("\n");
        return { ...slice, text: `${text}\n\n实际台词\n${speech || (record.speech ? "未取得该镜头的语音时间证据" : "语音识别尚未完成")}`, dataUrl: frames[slice.index].dataUrl };
      });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rows.map(r => r.index).join(",")));
      const suffix = Array.from(new Uint8Array(digest)).map(n => n.toString(16).padStart(2,"0")).join("").slice(0,24);
      await props.onAddAnalysis({ id: `${record.id}-${suffix}`, rows });
      notifySuccess("已添加到画板：每个镜头一行，左侧关键帧、右侧分析");
    } catch (e) { notifyError(e, "添加内容卡片失败，请重试"); }
    finally { exportLock.current = false; if (alive.current) setExporting(false); }
  }
  async function act(action: string) {
    if (locked.current) return; locked.current = true; setBusy(true); setError("");
    try {
      if (action === "enhanced-prepare") await props.beforePrepare();
      const value = await call<Record>(props.projectId, action, { id, caseId: props.caseId, persona, rules,
        direction, prompts: record?.frozenPrompts || prompts });
      accept(value); if (action === "enhanced-prepare") props.onPrepared(value.id);
    } catch (e) { if (alive.current) setError(userErrorMessage(e, "强化复刻未完成，请稍后恢复原任务")); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const stage = record?.outputPath || record?.frozenPrompts ? 2 : record?.speech ? 1 : 0;
  const shot = record?.slices.find(s => s.index === selectedShot) || record?.slices[0];
  const prompt = prompts.find(p => p.index === shot?.index);
  const analysis = record?.analysis?.find(a => a.index === shot?.index)?.analysis.analysisText;
  async function copyAnalysis() {
    if (!analysis?.trim()) return;
    try {
      await navigator.clipboard.writeText(analysis);
      notifySuccess("镜头分析已复制");
    } catch (e) {
      notifyError(e, "复制镜头分析失败，请重试");
    }
  }
  const dirty = JSON.stringify(prompts) !== JSON.stringify(record?.prompts || []);
  const unavailable = caps.loading ? "正在读取 Cloud 服务状态…" : caps.error ? "暂时无法获取服务状态，请刷新后重试。"
    : !available("speech-transcription") ? "Cloud 语音服务暂不可用，可先完成本机切片。"
    : !available(record?.speech ? "text-rewrite" : "video-analysis") && !record?.prompts ? "当前 Cloud 服务暂不可用，请稍后重试。" : "";
  return <section className="vr-enhanced" aria-label="强化分析">
    <h3 className="vre-title">强化分析</h3>
    <div className="vre-body">
      <ol className="vre-steps" aria-label="强化复刻进度">
        {["分析原片", "编辑分镜", "生成成片"].map((label, index) => <li key={label} aria-current={index === stage ? "step" : undefined} className={index < stage ? "is-done" : ""}>
          <span>{index < stage ? "✓" : `0${index + 1}`}</span>{label}
        </li>)}
      </ol>
      <div className="vre-status" role="status" aria-live="polite">
        <strong>{record?.outputPath ? "成片已就绪" : running || busy ? "正在处理" : record?.state === "interrupted" ? "任务已暂停" : record?.speech ? "检查分镜，再生成" : record ? `已拆分 ${record.slices.length} 个镜头` : "先拆镜头，再理解内容"}</strong>
        <p>{record?.message || (id && !record ? "正在读取原任务…" : record?.prompts ? "逐镜检查提示词。切换镜头不会丢失编辑，生成时使用当前分镜。" : record?.speech ? "先查看分析与原片台词，再填写本次改写方向。" : "在本机检测画面切换，再逐段分析画面并识别原片语音。")}</p>
      </div>
      {(error || record?.error) && <p className="vr-message is-error" role="alert">{error || userErrorMessage(record?.error, "强化复刻未完成")}</p>}
      {record && <>
        <div className="vre-workspace">
          <nav className="vre-shots" aria-label="选择镜头">
            {record.slices.map((slice, index) => <div className="vre-shot" key={slice.index}>
              <button type="button" aria-label={`查看镜头 ${index + 1}`} aria-pressed={shot?.index === slice.index} onClick={() => { setSelectedShot(slice.index); props.onViewShot?.(slice.start); }}>
                {frames[slice.index] ? <img src={frames[slice.index].dataUrl} alt={`镜头 ${index + 1} 关键帧`} /> : <span className="vre-frame-placeholder">正在提取关键帧…</span>}
                <strong>镜头 {String(index + 1).padStart(2, "0")}</strong>
                <span>{slice.start.toFixed(1)}–{slice.end.toFixed(1)} 秒</span>
              </button>
              <label className="vre-shot-select"><input type="checkbox" aria-label={`选择镜头 ${index + 1}`} checked={selected.includes(slice.index)} disabled={exporting}
                onChange={e => setSelected(current => e.target.checked ? [...current, slice.index] : current.filter(i => i !== slice.index))} />{record.analysis?.some(a => a.index === slice.index) ? "已分析" : "待分析"}{slice.boundary === "duration" ? " · 长镜头分段" : ""}</label>
            </div>)}
          </nav>
          <div className="vre-shot-detail">
            {shot && frames[shot.index] && <img className="vre-keyframe" src={frames[shot.index].dataUrl} alt={`镜头 ${shot.index + 1} 当前关键帧`} />}
            <div className="vre-shot-heading"><div className="vre-shot-title"><strong>镜头 {String((shot?.index ?? 0) + 1).padStart(2, "0")}</strong><button type="button" className="vre-copy" aria-label="复制镜头分析" title="复制镜头分析" disabled={!analysis?.trim()} onClick={() => void copyAnalysis()}><Copy size={14} aria-hidden="true" /></button></div><span>{shot ? `${(shot.end - shot.start).toFixed(1)} 秒原片` : ""}{prompt ? ` → ${prompt.duration} 秒生成` : ""}</span></div>
            {prompt ? <>
              <section className="vre-disclosure"><h4>原片分析</h4><p className="vre-analysis">{analysis || "暂无分析内容"}</p></section>
              <label className="vr-field">第 {(shot?.index ?? 0) + 1} 段生成提示词
                <textarea rows={8} maxLength={12000} value={prompt.prompt} disabled={busy || running || !!record.frozenPrompts}
                  onChange={e => setPrompts(current => current.map(p => p.index === prompt.index ? { ...p, prompt: e.target.value } : p))} />
              </label>
              {record.frozenPrompts && <p className="vr-hint">生成已开始，分镜已锁定。</p>}
            </> : <p className="vre-analysis">{analysis || "分析完成后，这里会显示当前镜头的画面、动作与拍摄特点。"}</p>}
          </div>
        </div>
        {frameError && <p className="vr-message is-error" role="alert">{frameError}<button onClick={() => setFrameRevision(n => n + 1)}>重试关键帧</button></p>}
        <div className="vre-output">
          <label><input type="checkbox" aria-label="选择全部镜头" checked={selected.length === record.slices.length && selected.length > 0} disabled={exporting}
            onChange={e => setSelected(e.target.checked ? record.slices.map(s => s.index) : [])} /> 全选</label>
          <span className="vr-hint">已选 {selected.length} 个镜头</span>
          {props.onAddAnalysis && <button className="app-button-primary" disabled={exporting || !selected.length || selected.some(i => !frames[i] || !record.analysis?.find(a => a.index === i)?.analysis.analysisText?.trim())}
            onClick={() => void addAnalysis()}>{exporting ? "正在添加…" : "添加到画板"}</button>}
        </div>
        <p className="vr-hint">一张内容卡片，每个镜头一行：左侧关键帧，右侧分析结果。</p>
        {record.speech && <section className="vre-disclosure"><h4>原片实际语音</h4><p className="vre-analysis">{record.speech.text || "未识别到台词"}</p></section>}
        {record.speech && !record.prompts && <fieldset className="vre-direction" disabled={busy || running}>
          <legend>这次想怎么改</legend>
          <label className="vr-field">强化复刻方向<textarea rows={3} maxLength={8000} placeholder="例如：保留节奏，换成产品使用场景" value={direction} onChange={e => setDirection(e.target.value)} /></label>
          <div className="vre-guidelines">
            <label className="vr-field">强化复刻人设<textarea rows={2} maxLength={8000} value={persona} onChange={e => setPersona(e.target.value)} /></label>
            <label className="vr-field">强化复刻规范<textarea rows={2} maxLength={15000} value={rules} onChange={e => setRules(e.target.value)} /></label>
          </div>
          {(!persona.trim() || !rules.trim()) && <p className="vr-hint">填写人设与规范后，即可改写分镜。</p>}
        </fieldset>}
        {prompts.length > 0 && !record.frozenPrompts && <section className="vre-disclosure"><h4>标记需要对齐的台词</h4><p className="vr-hint">用 [[编号|台词]] 标记关键台词。生成后按实际语音对齐，重复或未识别的台词会保留为未对齐。</p></section>}
      </>}
      {record?.outputPath && <VideoPlayer path={record.outputPath} embedded />}
      {!!record?.markerEvents?.some(event => event.status !== "aligned") && <section className="vre-disclosure"><h4>有台词未对齐</h4>{record.markerEvents.filter(event => event.status !== "aligned").map((event, index) => <p className="vr-hint" key={`${event.id}:${index}`}>{event.id}：{event.status === "ambiguous" ? "存在重复，未自动对齐" : "未找到词级时间证据"}</p>)}</section>}
      <footer className="vre-footer">
        {!id ? <><span className="vr-hint">本机处理，不消耗 Bcoin</span><button className="app-button-primary" disabled={busy} onClick={() => void act("enhanced-prepare")}>{busy ? "正在检测并切片…" : "检测切点并准备切片"}</button></> : record && <>
          {!record.outputPath && <div className="vre-price">
            {unavailable ? <><span>{unavailable}</span>{caps.error && <button onClick={caps.refresh}>刷新服务状态</button>}</> : <span>{!record.speech ? `分析 ${cost("video-analysis")} Bcoin / 段 · 原片语音 ${cost("speech-transcription")} Bcoin / 次`
              : !record.prompts ? `改写 ${cost("text-rewrite")} Bcoin / 段 · 共 ${record.slices.length} 段`
              : `即梦自有订阅生成 · 新片语音 ${cost("speech-transcription")} Bcoin / 段`}</span>}
            {(busy || running) && <span>可离开面板，稍后回来查看进度。</span>}
          </div>}
          <div className="vre-buttons">
            {record.state === "interrupted" ? <button className="app-button-primary" disabled={busy} onClick={() => void act(record.resumeAction || "enhanced-analyze")}>恢复原任务</button> : <>
              {!record.speech && <button className="app-button-primary" disabled={busy || running || !!unavailable} onClick={() => void act("enhanced-analyze")}>逐段分析并识别语音</button>}
              {record.speech && !record.prompts && <button className="app-button-primary" disabled={busy || running || !!unavailable || !persona.trim() || !rules.trim()} onClick={() => void act("enhanced-plan")}>改写各段分镜</button>}
              {prompts.length > 0 && !record.outputPath && <>
                {!record.frozenPrompts && <button className="app-button-secondary" disabled={busy || running || !dirty} onClick={() => void act("enhanced-save")}>{dirty ? "保存分镜" : "分镜已保存"}</button>}
                <button className="app-button-primary" disabled={busy || running || !available("speech-transcription") || prompts.some(p => !p.prompt.trim())} onClick={() => void act("enhanced-finish")}>逐段生成并合成字幕成片</button>
              </>}
            </>}
            {record.outputPath && props.onAddVideo && <button className="app-button-primary" disabled={busy} onClick={() => {
              setBusy(true); void props.onAddVideo!(record.outputPath!, `enhanced:${record.id}`).catch(e => setError(userErrorMessage(e, "添加成片失败"))).finally(() => { if (alive.current) setBusy(false); });
            }}>添加成片到画板</button>}
          </div>
        </>}
      </footer>
    </div>
  </section>;
}
