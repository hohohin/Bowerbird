import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, Copy, History, ImagePlus, LoaderCircle, Play, Plus } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { VideoPlayer } from "./VideoPlayer";
import { DouyinReferencePicker } from "./DouyinReferencePicker";
import { ReplicationFields, replicationTabs } from "./VideoReplicationForms";
import { REPLICATION_PERSONA, REPLICATION_RULES, replicationDuration, replicationRewriteParts, replicationRunning, replicationStateLabel, validateReplicationInput, type ReplicationInput, type ReplicationOperation, type ReplicationProduct, type ReplicationReference, type ReplicationTask, type ReplicationFrameReference, type ReplicationImageRequest } from "../lib/videoReplication";
import { api } from "../lib/api";
import { videoTime, type VideoFrame } from "../lib/videoFrame";
import { DEFAULT_VIDEO_OPTIONS } from "../lib/videoGeneration";
import { notify } from "../lib/notify";
import { useStore } from "../store";
import type { Asset } from "../lib/types";
import "./VideoReplication.css";

interface Preferences { persona: string; rules: string; products: ReplicationProduct[] }
interface Capability { operation: "video-analysis" | "text-rewrite"; available: boolean; credits: number | null }
const fresh = (operation: Exclude<ReplicationOperation, "generate">, prefs: Preferences): ReplicationInput => ({ operation, title: operation === "analyze" ? "视频分析" : "内容改写", persona: prefs.persona, rules: prefs.rules, ratio: "9:16" });

export function VideoReplicationDialog({ projectId, onClose, ensureProject, onGenerateImage }: { projectId: string; onClose: () => void; ensureProject: () => Promise<void>; onGenerateImage?: (request: ReplicationImageRequest) => Promise<void> }) {
  const call = <T,>(action: string, data: unknown = {}) => invoke<T>("video_replication", { projectId, action, data });
  const [prefs, setPrefs] = useState<Preferences>({ persona: REPLICATION_PERSONA, rules: REPLICATION_RULES, products: [] });
  const [input, setInput] = useState<ReplicationInput>(() => fresh("analyze", prefs));
  const [tasks, setTasks] = useState<ReplicationTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tasks.find(task => task.id === selectedId) ?? null;
  const [reference, setReference] = useState<ReplicationReference | null>(null);
  const [mediaPath, setMediaPath] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [capabilities, setCapabilities] = useState<{ status: "loading" | "ready" | "error"; services: Capability[]; error: string }>({ status: "loading", services: [], error: "" });
  const [capabilityRefresh, setCapabilityRefresh] = useState(0);
  const authIdentity = useStore(state => `${state.cloudAuth?.user_id ?? ""}:${state.cloudAuth?.logged_in ?? false}`);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [picker, setPicker] = useState(false);
  const [douyinPicker, setDouyinPicker] = useState(false);
  const [sources, setSources] = useState<Asset[]>([]);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [firstFramePrompt, setFirstFramePrompt] = useState("");
  const [frameReference, setFrameReference] = useState<ReplicationFrameReference | null>(null);
  const [framePreview, setFramePreview] = useState("");
  const [edited, setEdited] = useState("");
  const dirty = useRef(false);
  const edits = useRef(new Map<string, { text: string; prompt: string; frame: ReplicationFrameReference | null }>());
  const drafts = useRef(new Map<string, { input: ReplicationInput; selectedId: string | null; reference: ReplicationReference | null; frame: ReplicationFrameReference | null }>());
  const operation = selected?.operation ?? input.operation;
  const available = capabilities.services.find(item => item.operation === (operation === "analyze" ? "video-analysis" : "text-rewrite"));

  const put = (task: ReplicationTask) => { setTasks(items => [task, ...items.filter(item => item.id !== task.id)]); setSelectedId(task.id); };
  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void call<Partial<Preferences>>("preferences").then(value => {
      if (disposed) return;
      const next = { persona: value.persona || REPLICATION_PERSONA, rules: value.rules || REPLICATION_RULES, products: value.products ?? [] };
      setPrefs(next); setInput(current => ({ ...current, persona: next.persona, rules: next.rules }));
    }).catch(e => !disposed && setError(String(e)));
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await call<ReplicationTask[]>("list"); if (!disposed) setTasks(current => JSON.stringify(current) === JSON.stringify(value) ? current : value); }
      catch (e) { if (!disposed) setNotice(`历史刷新失败：${String(e)}`); }
      if (!disposed) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => { alive.current = false; disposed = true; clearTimeout(timer); };
  }, [projectId]);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    setCapabilities({ status: "loading", services: [], error: "" });
    async function refresh() {
      if (disposed || inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      let delay = 30000;
      try {
        const value = await Promise.race([
          invoke<{ services: Capability[] }>("video_replication", { projectId, action: "capabilities", data: {} }),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("读取 Cloud 价格超时，请重试")), 15000); }),
        ]);
        if (!["video-analysis", "text-rewrite"].every(operation => value?.services?.some(item => item.operation === operation && typeof item.available === "boolean" && (!item.available || (typeof item.credits === "number" && item.credits > 0))))) throw new Error("Cloud 返回的服务状态不完整，请重试");
        if (!disposed) setCapabilities(current => current.status === "ready" && JSON.stringify(current.services) === JSON.stringify(value.services) ? current : { status: "ready", services: value.services, error: "" });
      } catch (error) {
        delay = 5000;
        const message = String(error);
        if (!disposed) setCapabilities({ status: "error", services: [], error: message.includes("未知 action") ? "当前连接的 Cloud 接口不支持服务状态查询，请重试" : message });
      } finally {
        clearTimeout(deadline);
        inFlight = false;
        if (!disposed) timer = setTimeout(refresh, delay);
      }
    }
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [projectId, authIdentity, capabilityRefresh]);
  useEffect(() => {
    dirty.current = selectedId !== null && edits.current.has(selectedId);
    const edit = selectedId ? edits.current.get(selectedId) : undefined;
    const parts = replicationRewriteParts(selected?.rewrittenText ?? "");
    setEdited(edit?.text ?? (selected?.firstFramePrompt === undefined ? parts.text : selected.rewrittenText));
    setFirstFramePrompt(edit?.prompt ?? selected?.firstFramePrompt ?? parts.firstFramePrompt);
    if (selected) setFrameReference(edit ? edit.frame : selected.frameReference ?? null);
  }, [selectedId]);
  useEffect(() => { if (!dirty.current) {
    const parts = replicationRewriteParts(selected?.rewrittenText ?? "");
    setEdited(selected?.firstFramePrompt === undefined ? parts.text : selected.rewrittenText);
    setFirstFramePrompt(selected?.firstFramePrompt ?? parts.firstFramePrompt);
  } }, [selected?.rewrittenText, selected?.firstFramePrompt]);
  const referenceId = selected?.referenceId ?? reference?.id ?? input.referenceId ?? (input.sourceAnalysisId ? tasks.find(task => task.id === input.sourceAnalysisId)?.referenceId : undefined);
  const viewIdentity = useRef("");
  viewIdentity.current = `${operation}:${selectedId ?? "draft"}:${referenceId ?? ""}`;
  useEffect(() => {
    let disposed = false; setMediaPath(null); setMediaError(""); setPlayerOpen(false);
    if (referenceId) void call<string>("media", { id: referenceId }).then(value => !disposed && setMediaPath(value)).catch(e => !disposed && setMediaError(String(e)));
    return () => { disposed = true; };
  }, [referenceId, projectId]);
  useEffect(() => {
    let disposed = false; setFramePreview("");
    if (frameReference) void api.getAssetsByIds([frameReference.assetId]).then(items => {
      if (!disposed) setFramePreview(items[0]?.store_path ? convertFileSrc(items[0].store_path) : "");
    }).catch(e => !disposed && setError(`参考图读取失败：${String(e)}`));
    return () => { disposed = true; };
  }, [frameReference?.assetId]);
  useEffect(() => {
    if (!picker) return;
    let disposed = false;
    void call<Asset[]>("sources", { query, offset }).then(value => !disposed && setSources(value)).catch(e => !disposed && setError(String(e)));
    return () => { disposed = true; };
  }, [picker, query, offset, projectId]);

  function newDraft(next: Exclude<ReplicationOperation, "generate">, patch: Partial<ReplicationInput> = {}) {
    remember();
    setSelectedId(null); setReference(patch.referenceId === reference?.id ? reference : null); setFrameReference(patch.frameReference ?? null);
    setPicker(false); setDouyinPicker(false); setPlayerOpen(false); setInput({ ...fresh(next, prefs), ...patch, product: null }); setError(""); setNotice("");
  }
  function remember() { drafts.current.set(operation, { input, selectedId, reference, frame: frameReference }); }
  function switchTab(next: "analyze" | "rewrite") {
    if (next === operation) return;
    remember();
    const draft = drafts.current.get(next);
    setSelectedId(draft?.selectedId ?? null); setInput(draft?.input ?? fresh(next, prefs)); setReference(draft?.reference ?? null); setFrameReference(draft?.frame ?? null);
    setPlayerOpen(false); setPicker(false); setDouyinPicker(false); setError(""); setNotice("");
  }
  function selectTask(task: ReplicationTask) {
    remember();
    setSelectedId(task.id); setInput({ ...task, product: null }); setReference(task.reference ?? tasks.find(item => item.id === task.sourceAnalysisId)?.reference ?? null);
    setPlayerOpen(false); setHistoryOpen(false); setPicker(false); setDouyinPicker(false); setError(""); setNotice("");
  }
  function changeResult(text: string, prompt = firstFramePrompt, frame = frameReference) {
    if (!selected) return;
    dirty.current = true; edits.current.set(selected.id, { text, prompt, frame });
    setEdited(text); setFirstFramePrompt(prompt); setFrameReference(frame);
  }
  async function saveResult() {
    if (!selected) throw new Error("请选择改写记录");
    const value = await call<ReplicationTask>("save-result", { id: selected.id, text: edited, firstFramePrompt, frameReference });
    if (alive.current) { edits.current.delete(selected.id); dirty.current = false; put(value); }
    return value;
  }
  async function captureFrame(frame: VideoFrame) {
    const view = viewIdentity.current;
    await ensureProject();
    const asset = await api.importImageBytes({ dataUrl: frame.dataUrl, projectId, source: "video-frame", fileName: `复刻参考-${frame.time.toFixed(3)}.png` });
    if (!alive.current || viewIdentity.current !== view) return;
    const value = { assetId: asset.id, time: frame.time, name: reference?.name ?? "参考视频" };
    setFrameReference(value);
    if (selected?.rewrittenText) changeResult(edited, firstFramePrompt, value);
    setNotice(`已截取 ${videoTime(frame.time)} 的画面作为首帧参考图`);
  }
  async function chooseReference(data: { path?: string; assetId?: string }) {
    await ensureProject();
    const value = await call<ReplicationReference>("reference", data);
    if (!alive.current) return;
    setSelectedId(null); setReference(value); setFrameReference(null); setInput(current => ({ ...current, referenceId: value.id, title: value.name.slice(0,100) })); setPicker(false);
  }
  async function submit() {
    const issue = validateReplicationInput(input); if (issue) throw new Error(issue);
    await ensureProject();
    const task = await call<ReplicationTask>("create", { ...input, frameReference, product: null });
    if (alive.current) put(task);
  }
  async function carryRewrite() {
    if ([...edited].length > 12000) throw new Error("改写结果超过 12000 字，请精简后带入生成");
    if (!edited.trim() || !selected) throw new Error("请先填写改写结果");
    const saved = await saveResult();
    if (!alive.current || useStore.getState().activeProjectId !== projectId) return;
    edits.current.delete(selected.id);
    dirty.current = false;
    const duration = replicationDuration(saved.rewrittenText);
    useStore.getState().reusePromptToBoard(saved.rewrittenText, [], [], null, {
      media: "video", videoOptions: { ...DEFAULT_VIDEO_OPTIONS, duration: duration ?? DEFAULT_VIDEO_OPTIONS.duration }, ratio: saved.ratio ?? "9:16",
    });
    onClose();
    if (duration === null) notify("未识别到有效分镜时间，已填入默认 5 秒，请在发送前调整");
  }

  async function generateFirstFrame() {
    if (!firstFramePrompt.trim() || !onGenerateImage) throw new Error("请填写首帧画面提示词");
    await saveResult();
    if (!alive.current || useStore.getState().activeProjectId !== projectId) return;
    await onGenerateImage({ prompt: firstFramePrompt, referenceId: frameReference?.assetId, ratio: selected?.ratio ?? "9:16" });
    if (alive.current) onClose();
  }

  const running = !!selected && replicationRunning(selected);
  const analyzed = !!selected?.analysis;
  const rewritten = !!selected?.rewriteOriginalText;
  const invalid = validateReplicationInput(input);
  const credits = available?.available ? ` · ${available.credits} 积分` : "";
  const displayedReference = reference ?? selected?.reference ?? null;
  const changeInput = (patch: Partial<ReplicationInput>) => setInput(current => ({ ...current, ...patch }));
  return <ModalShell title="视频复刻工具" eyebrow="工具箱" width="lg" className="video-replication" onClose={onClose} preventClose={busy}
    headerActions={<div className="vr-actions"><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><History size={15} />记录</button><button type="button" aria-label="新建复刻记录" disabled={busy} onClick={() => newDraft(operation === "generate" ? "rewrite" : operation)}><Plus size={15} />新建</button></div>}>
    {historyOpen && <aside className="vr-history" aria-label="复刻历史"><div className="vr-history-heading">本项目记录</div>
      {!tasks.length && <p className="vr-hint">执行记录会保存在这里</p>}
      {tasks.map(task => <button key={task.id} type="button" disabled={busy} aria-current={selectedId === task.id} onClick={() => selectTask(task)}><strong>{task.title}</strong><small>{replicationTabs.find(tab => tab.id === task.operation)?.label ?? "历史生成"} · {replicationStateLabel[task.state]}</small></button>)}
    </aside>}
    <main className="vr-main">
      <nav className="vr-tabs" aria-label="复刻操作">{replicationTabs.map(tab => <button type="button" key={tab.id} disabled={busy} aria-pressed={operation === tab.id} onClick={() => switchTab(tab.id)}><tab.icon size={18} /><strong>{tab.label}</strong></button>)}</nav>
      {error && <div className="vr-message is-error" role="alert">{error}</div>}{notice && <div className="vr-message" role="status">{notice}</div>}
      {selected?.operation === "generate" ? <section className="vr-legacy"><pre className="vr-result">{selected.prompt}</pre>
          <p className="vr-hint">视频生成已统一到项目画板。</p>
          {selected.generationJobId && <div className="vr-actions"><button type="button" onClick={() => { useStore.getState().openGenerationJob(selected.generationJobId!); onClose(); }}>查看画板生成会话</button></div>}</section>
      : <div className="vr-workbench"><section className="vr-context" aria-label="输入区">
        {operation === "rewrite" && referenceId && <section className="vr-video-reference" aria-label="改写参考视频">
          <div className="vr-video-summary">{mediaPath && !playerOpen && <video src={convertFileSrc(mediaPath)} preload="metadata" muted playsInline aria-label="参考视频封面" />}<div><strong>{displayedReference?.name || "参考视频"}</strong><p className="vr-hint">{displayedReference?.duration?.toFixed(1)} 秒 · 来自本次分析</p><button type="button" className="vr-text-button" disabled={!mediaPath} aria-expanded={playerOpen} onClick={() => setPlayerOpen(value => !value)}><Play size={14} />{playerOpen ? "收起播放器" : "查看 / 截帧"}</button></div></div>
          {mediaPath && playerOpen && <VideoPlayer key={mediaPath} path={mediaPath} embedded frameTarget="reference" onAddFrame={captureFrame} />}
        </section>}
        <h3>{operation === "analyze" ? "参考视频" : "改写输入"}</h3>
        <ReplicationFields input={input} onChange={changeInput} reference={displayedReference} disabled={busy || running}
          onUpload={() => void action(async () => { const path = await open({ multiple: false, filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm", "mkv", "avi"] }] }); if (typeof path === "string") await chooseReference({ path }); })}
          onPickLibrary={() => { setPicker(value => !value); setDouyinPicker(false); setOffset(0); }}
          onPickDouyin={() => { setDouyinPicker(value => !value); setPicker(false); }}
          onSaveDefaults={() => void action(async () => { const next = { ...prefs, persona: input.persona!, rules: input.rules! }; await call("save-preferences", next); setPrefs(next); setNotice("默认人设与规范已保存"); })} />
        {douyinPicker && operation === "analyze" && <DouyinReferencePicker projectId={projectId} ensureProject={ensureProject} onUse={value => { setSelectedId(null); setReference(value); changeInput({ referenceId: value.id, title: value.name.slice(0,100) }); setDouyinPicker(false); }} />}
        {picker && <section className="vr-picker"><label className="vr-field">搜索素材库视频<input value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} /></label>{sources.map(asset => <button type="button" key={asset.id} disabled={busy} onClick={() => void action(() => chooseReference({ assetId: asset.id }))}>{asset.name} · {(asset.duration ?? 0).toFixed(1)} 秒</button>)}{!sources.length && <p className="vr-hint">没有匹配的视频</p>}<div className="vr-actions"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-40))}>上一页</button><button type="button" disabled={sources.length<40} onClick={() => setOffset(offset+40)}>下一页</button></div></section>}
        {mediaError && <div className="vr-message is-error" role="alert">{mediaError}</div>}{operation === "analyze" && mediaPath && <VideoPlayer key={mediaPath} path={mediaPath} embedded />}
        <details className="vr-record-title"><summary>记录名称</summary><label className="vr-field">标题<input value={input.title} maxLength={100} disabled={busy || running} onChange={event => changeInput({ title: event.target.value })} /></label></details>
      </section><section className="vr-output" aria-label="结果区">
        <div className="vr-output-heading"><h3>{operation === "analyze" ? "视频分析" : "改写结果"}</h3><span className="vr-hint">{selected ? replicationStateLabel[selected.state] : operation === "analyze" ? "待分析" : "待改写"}</span></div>
        {running && <p className="vr-message" role="status"><LoaderCircle size={14} className="animate-spin inline" /> {selected?.message || "处理中…"}</p>}
        {selected?.error && <div className="vr-message is-error" role="alert">{selected.error}</div>}
        {!selected && <p className="vr-result-placeholder">{operation === "analyze" ? referenceId ? "视频已就绪，点击下方「开始分析」。" : "获取视频后开始分析。" : "填写参考文本与改写方向，点击下方「开始改写」。"}</p>}
        {analyzed && <><pre className="vr-result">{selected!.analysis}</pre><div className="vr-actions"><button type="button" onClick={() => void action(async () => { await navigator.clipboard.writeText(selected!.analysis); setNotice("已复制分析文本"); })}><Copy size={14} />复制</button></div></>}
        {rewritten && <>
          <label className="vr-field">改写结果（可编辑）<textarea aria-label="改写结果（可编辑）" rows={9} maxLength={50000} disabled={busy} value={edited} onChange={e => changeResult(e.target.value)} /></label>
          <div className="vr-output-heading"><span className="vr-hint">{replicationDuration(edited) ? `生成时长 ${replicationDuration(edited)} 秒` : "未识别分镜时长"}</span><div className="vr-actions"><button type="button" disabled={busy} onClick={() => void action(async () => { await saveResult(); setNotice("已保存修改"); })}>保存修改</button><button type="button" onClick={() => void action(async () => { await navigator.clipboard.writeText(edited); setNotice("已复制改写结果"); })}>复制</button></div></div>
          <section className="vr-first-frame"><h3>首帧画面提示词</h3><label className="vr-field"><span className="vr-hint">来自本次改写结果 · 可编辑</span><textarea aria-label="首帧画面提示词" rows={4} maxLength={12000} disabled={busy} value={firstFramePrompt} onChange={event => changeResult(edited, event.target.value)} /></label>
            {!firstFramePrompt.trim() && <p className="vr-hint">未识别到首帧提示词，可在这里补写，或从模型原文粘贴。</p>}
            {frameReference && <div className="vr-frame-reference">{framePreview && <img src={framePreview} alt="首帧生成参考图" />}<div><strong>参考图 · 视频截帧</strong><p className="vr-hint">{frameReference.name} · {videoTime(frameReference.time)}</p><div className="vr-actions"><button type="button" disabled={!mediaPath} onClick={() => setPlayerOpen(true)}>更换</button><button type="button" disabled={busy} onClick={() => changeResult(edited, firstFramePrompt, null)}>移除</button></div></div></div>}
            <div className="vr-actions"><button type="button" disabled={busy || !onGenerateImage || !firstFramePrompt.trim()} onClick={() => void action(generateFirstFrame)}><ImagePlus size={15} />生成首帧图片</button></div><p className="vr-hint">在画板新建生成卡片 · 使用当前图片渠道</p>
          </section>
        </>}
        {selected && <details className="vr-original"><summary>查看模型原文与提交快照</summary><pre className="vr-payload">{selected.rewriteOriginalText || selected.analysis}</pre><pre className="vr-payload">{selected.persona}{"\n\n"}{selected.rules}{"\n\n"}{selected.inputText}{"\n\n"}{selected.rewriteDirection}</pre><p className="vr-hint">模型用量：{selected.usage ? `输入 ${selected.usage.inputTokens ?? "未记录"} · 输出 ${selected.usage.outputTokens ?? "未记录"}` : "未记录"}</p></details>}
      </section></div>}
    </main>
    {operation !== "generate" && <footer className="vr-footer"><div>
            <p className="vr-hint" role="status">Bowerbird Cloud · {operation === "analyze" ? "视频分析" : "文本改写"} · {capabilities.status === "loading" ? "正在读取价格…" : capabilities.status === "error" ? "价格读取失败" : available?.available ? `${available.credits} 积分 / 次` : operation === "analyze" ? "分析服务暂不可用" : "改写尚未启用"}</p>
            {capabilities.status === "error" && <p className="vr-message is-error" role="alert">{capabilities.error}</p>}
            {capabilities.status !== "loading" && (capabilities.status === "error" || !available?.available) && <button type="button" className="vr-text-button" onClick={() => setCapabilityRefresh(value => value + 1)}>重新读取 Cloud 状态</button>}
            {!selected && invalid && <p className="vr-hint">{invalid}</p>}
      </div><div className="vr-actions">
        {selected && ["failed", "interrupted"].includes(selected.state) && <button type="button" disabled={busy} onClick={() => void action(async () => put(await call<ReplicationTask>("resume", { id: selected.id })))}>恢复原任务</button>}
        {(analyzed || rewritten || selected && !running) && <button type="button" disabled={busy || !available?.available || !!invalid} onClick={() => void action(submit)}>{operation === "analyze" ? "重新分析" : "重新改写"}{credits}</button>}
        {analyzed ? <button type="button" className="is-primary" disabled={busy} onClick={() => newDraft("rewrite", { inputText: selected!.analysis, sourceAnalysisId: selected!.id, referenceId: selected!.referenceId })}>开始改写 <ArrowRight size={14} /></button>
          : rewritten ? <button type="button" className="is-primary" disabled={busy || !edited.trim()} onClick={() => void action(carryRewrite)}>插入到对话框 <ArrowRight size={14} /></button>
          : !selected && <button type="button" className="is-primary" disabled={busy || !available?.available || !!invalid} onClick={() => void action(submit)}>{busy ? "处理中…" : operation === "analyze" ? "开始分析" : "开始改写"}{credits}</button>}
        {running && <span className="vr-hint">{replicationStateLabel[selected!.state]}</span>}
      </div></footer>}
  </ModalShell>;
}
