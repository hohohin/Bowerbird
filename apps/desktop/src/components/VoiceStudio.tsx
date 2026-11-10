import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Plus, Play, AudioLines } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { AudioWaveform } from "./AudioWaveform";
import { VoiceReferenceTrim } from "./VoiceReferenceTrim";
import { api } from "../lib/api";
import { materialCatalog } from "../lib/materialCatalog";
import { voiceApi, type VoiceConfig, type VoiceSnapshot, type VoiceEnvironment, type VoiceJob } from "../lib/voice";
import { readVoiceDraft, writeVoiceDraft, voicePreviewKey, type VoiceDraft } from "../lib/voiceStudioDraft";
import { playAudioPreview, stopAudioPreview, audioPreviewKey, audioPreviewPosition } from "../lib/audioPreview";
import { saveMediaAssetToCanvas } from "../lib/videoCollectionCanvas";
import type { Asset } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import "./VoiceStudio.css";

const SAMPLE = "欢迎回来，我们可以开始今天的创作了。";
type View = "main" | "create" | "setup" | "manage" | "remove" | "library";
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
export function VoiceStudio({ projectId, onPrepare, onClose }: { projectId: string; onPrepare: () => Promise<unknown>; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null), [environment, setEnvironment] = useState<VoiceEnvironment | null>(null);
  const [config, setConfig] = useState<VoiceConfig>({ python: "", model: "" });
  const [draft, setDraft] = useState(() => readVoiceDraft(projectId)), [view, setView] = useState<View>("main");
  const [source, setSource] = useState<Asset | null>(null), [library, setLibrary] = useState<Asset[]>([]), [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0), [more, setMore] = useState(false), [rename, setRename] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const guard = useRef(false), alive = useRef(true), initialized = useRef(false), owner = useRef({}), revision = useRef(0);
  const change = useCallback((patch: Partial<VoiceDraft>) => setDraft(old => ({ ...old, ...patch })), []);
  useEffect(() => { try { writeVoiceDraft(projectId, draft); } catch { setError("草稿暂时无法保存，请不要关闭面板，稍后重试。"); } }, [projectId, draft]);
  useEffect(() => {
    alive.current = true; let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const started = revision.current;
      try {
        const [next, env] = await Promise.all([voiceApi.snapshot(projectId), voiceApi.environment()]);
        if (disposed || guard.current || started !== revision.current) return;
        setSnapshot(next); setEnvironment(env);
        if (!initialized.current) { initialized.current = true; setConfig(next.config); }
        setDraft(old => next.voices.some(v => v.id === old.voiceId) ? old : { ...old, voiceId: next.voices[0]?.id ?? "" });
      } catch (e) { if (!disposed) setError(userErrorMessage(e, "声音记录读取失败，请重新打开面板。")); }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 1500); }
    }; void refresh();
    return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, [projectId]);
  useEffect(() => { let stale = false; setSource(null);
    if (draft.sourceId) void api.getAssetsByIds([draft.sourceId]).then(values => { if (!stale) setSource(values[0] ?? null); }).catch(e => { if (!stale) setError(userErrorMessage(e, "参考录音暂不可用，请重新选择")); });
    return () => { stale = true; };
  }, [draft.sourceId]);
  useEffect(() => {
    if (view !== "library") return; let stale = false;
    void materialCatalog.page({ kind: "all", id: null, projectId, media: "audios", query, generated: null, color: null }, offset, 50)
      .then(values => { if (!stale) { setLibrary(old => offset ? [...old, ...values] : values); setMore(values.length === 50); } })
      .catch(e => { if (!stale) setError(userErrorMessage(e, "素材读取失败，请稍后重试")); });
    return () => { stale = true; };
  }, [view, query, offset, projectId]);
  async function act(action: () => Promise<void>) {
    if (guard.current) return; guard.current = true; revision.current++; setBusy(true); setError(""); setNotice("");
    try { await action(); if (alive.current) setSnapshot(await voiceApi.snapshot(projectId)); }
    catch (e) { if (alive.current) setError(userErrorMessage(e, "操作未完成，请稍后重试。")); }
    finally { guard.current = false; if (alive.current) setBusy(false); }
  }
  const preview = (asset?: Asset | null) => asset?.store_path ? <AudioWaveform assetId={asset.id} path={asset.store_path} name={asset.name} version={asset.file_mtime ?? asset.created_at ?? 0} duration={asset.duration} /> : null;
  const selected = snapshot?.voices.find(v => v.id === draft.voiceId);
  const running = snapshot?.jobs.some(job => job.status === "running"), ready = environment?.phase === "ready";
  const previewKey = voicePreviewKey(draft);
  const audition = snapshot?.jobs.find(job => job.purpose === "preview" && job.draft_key === previewKey && job.id === draft.previewId);
  const auditionAsset = snapshot?.assets.find(a => a.id === audition?.asset_id);
  const validClip = !!source && draft.end - draft.start >= .999 && draft.end - draft.start <= 30.001;
  const canSave = !!draft.name.trim() && (draft.mode === "clone" ? validClip : !!auditionAsset);
  function go(next: View) { setError(""); setNotice(""); setView(next); }
  function choose(asset: Asset) { setSource(asset); change({ sourceId: asset.id, name: asset.name.replace(/\.[^.]+$/, ""), transcript: "", start: 0, end: Math.min(asset.duration ?? 0, 12), previewId: "", mode: "clone" }); go("create"); }
  function importRecording() { void act(async () => {
    const path = await open({ multiple: false, filters: [{ name: "参考录音", extensions: ["wav", "mp3", "flac", "m4a", "ogg"] }] });
    if (typeof path !== "string") return;
    await onPrepare(); const [asset] = await api.importFiles([path], projectId, true);
    if (!asset) throw new Error("录音未能导入，请重试"); choose(asset);
  }); }
  function playSelected() { if (!selected) return;
    const source = { assetId: `voice:${selected.id}`, path: selected.reference, sourceVersion: selected.id, duration: selected.duration ?? 30 };
    if (audioPreviewPosition(audioPreviewKey(source))) stopAudioPreview(source.assetId); else playAudioPreview(source, 0, true, owner.current);
  }
  async function generate(job?: VoiceJob) {
    const text = job?.text ?? draft.text, voiceId = job?.voice_id ?? draft.voiceId;
    if (!voiceId || !snapshot?.voices.some(v => v.id === voiceId)) throw new Error("这个声音已移除，请先选择其他声音");
    await onPrepare(); await voiceApi.start(projectId, text, "", voiceId); change({ text, voiceId });
  }
  const close = () => { stopAudioPreview(); onClose(); };
  const title = ({ main: "角色声音", create: "创建声音", setup: "启用本机配音", manage: "管理声音", remove: "删除这个声音？", library: "选择参考录音" })[view];
  return <ModalShell title={title} width="lg" className={`voice-studio ${view === "main" ? "voice-studio-main" : "voice-studio-dialog"}`} onClose={close} preventClose={busy}
    headerActions={view !== "main" && <button className="app-modal-button" aria-label="返回角色声音" disabled={busy} onClick={() => go(view === "library" ? "create" : "main")}><ArrowLeft size={16} /></button>}>
    {view === "main" ? <div className="voice-studio-layout"><aside className="voice-studio-sidebar"><div className="voice-studio-sidebar-title">我的声音 <span>{snapshot?.voices.length ?? 0}</span></div>
      <div className="voice-studio-voices">{snapshot?.voices.map(voice => <button key={voice.id} className="voice-studio-voice" aria-pressed={voice.id === draft.voiceId} onClick={() => change({ voiceId: voice.id })}><span className="voice-studio-avatar">{voice.name.slice(0,1)}</span><span>{voice.name}</span></button>)}</div>
      <button className="app-modal-button" onClick={() => go(ready ? "create" : "setup")}><Plus size={15} /> 创建声音</button>
      <button className="voice-studio-environment" onClick={() => go("setup")}>{environment?.phase === "installing" ? "正在准备本机配音…" : ready ? "本机配音已就绪" : "启用本机配音"}</button><small>声音在这台电脑上生成</small></aside>
      <main className="voice-studio-content">{!ready || !selected ? <div className="voice-studio-empty"><AudioLines size={30} /><h3>{ready ? "为你的角色，找到声音" : "让你的角色开口说话"}</h3><p>{ready ? "从一段录音开始，或用文字描述你想要的声音。" : "第一次使用，应用会自动准备本机配音所需的组件。"}</p><button className="app-modal-button is-primary" disabled={!environment} onClick={() => go(ready ? "create" : "setup")}>{ready ? "创建第一个声音" : "启用本机配音"}</button></div> : <>
        <div className="voice-studio-source"><span className="voice-studio-avatar">{selected.name.slice(0,1)}</span><strong>{selected.name}</strong><button className="app-modal-button" onClick={playSelected}>试听</button><button className="app-modal-button" onClick={() => { setRename(selected.name); go("manage"); }}>管理</button></div>
        <label className="voice-studio-editor">台词<textarea aria-label="台词" value={draft.text} onChange={e => change({ text: e.target.value })} placeholder="让这个角色，说出你写下的话…" /><small>草稿自动保存 <span>{draft.text.length} 字</span></small></label>
        <div className="voice-studio-actions"><small>生成结果保存到当前项目</small><button className="app-modal-button is-primary" disabled={busy || running || !draft.text.trim()} onClick={() => void act(() => generate())}>{running ? "正在生成…" : "生成配音"}</button></div>
      </>}
      <section aria-label="本项目配音" className="voice-studio-results"><h3>本项目配音</h3>{snapshot?.jobs.filter(j => j.purpose !== "preview").map(job => {
        const asset = snapshot.assets.find(item => item.id === job.asset_id);
        return <article key={job.id} aria-busy={job.status === "running"}><small>{job.voice_name || "角色配音"}</small><p>{job.text}</p>{preview(asset)}<p className="voice-studio-hint">{userErrorMessage(job.message, "请查看任务状态")}</p><div className="voice-studio-row">
          {job.status === "running" && <button className="app-modal-button" disabled={busy} onClick={() => void act(() => voiceApi.cancel(job.id))}>取消生成</button>}
          {job.recoverable && <button className="app-modal-button" disabled={busy} onClick={() => void act(() => voiceApi.recover(job.id))}>重试保存</button>}
          {asset && <><button className="app-modal-button" disabled={busy || draft.canvas.includes(job.id)} onClick={() => void act(async () => { await saveMediaAssetToCanvas(asset, projectId, `voice:${job.id}`); change({ canvas: [...draft.canvas, job.id] }); })}>{draft.canvas.includes(job.id) ? "已添加到画板" : "添加到画板"}</button><button className="app-modal-button" disabled={busy} onClick={() => void act(() => voiceApi.export(asset.id))}>导出音频</button></>}
          {job.status !== "running" && !job.recoverable && <button className="app-modal-button" disabled={busy || running || !ready} onClick={() => void act(() => generate(job))}>{asset ? "再生成一版" : "重新生成"}</button>}
        </div></article>;
      })}</section></main></div> : <div className="voice-studio-body">
      {view === "create" && <><div className="voice-studio-modes" role="group" aria-label="创建方式">{(["clone", "design"] as const).map(mode => <button className="app-modal-button" key={mode} disabled={busy} aria-pressed={draft.mode === mode} onClick={() => change({ mode, previewId: "" })}>{mode === "clone" ? "用录音创建" : "用文字创建"}</button>)}</div>
        {draft.mode === "clone" ? source ? <><div className="voice-studio-source"><strong>{source.name}</strong><button className="app-modal-button" disabled={busy} onClick={importRecording}>更换</button></div><VoiceReferenceTrim asset={source} start={draft.start} end={draft.end} disabled={busy} onChange={change} /></> : <div className="voice-studio-drop"><AudioLines size={28} /><h3>放入一段角色录音</h3><div className="voice-studio-row"><button className="app-modal-button" disabled={busy} onClick={importRecording}>选择音频文件</button><button className="app-modal-button" disabled={busy} onClick={() => { setOffset(0); go("library"); }}>从素材库选择</button></div><small>清晰的单人录音 · WAV / MP3 / FLAC / M4A / OGG</small></div>
          : <label>描述你想要的声音<textarea rows={3} value={draft.description} onChange={e => change({ description: e.target.value })} placeholder="例如：年轻男性，低沉温暖，语气平静，适合叙事。" /></label>}
        {(source || draft.mode === "design") && <label>声音名称<input value={draft.name} onChange={e => change({ name: e.target.value })} placeholder="例如：林岸、旁白" /></label>}
        {source && draft.mode === "clone" && <details><summary>录音原文（可选）</summary><textarea value={draft.transcript} onChange={e => change({ transcript: e.target.value })} placeholder="默认留空。填写时须与当前选中片段准确一致。" /></details>}
        <div className="voice-studio-audition"><small>试听台词：{SAMPLE}</small><button className="app-modal-button" disabled={busy || running || !ready || (draft.mode === "clone" ? !validClip : !draft.description.trim())} onClick={() => void act(async () => { await onPrepare(); const id = await voiceApi.start(projectId, SAMPLE, draft.mode === "design" ? draft.description : "", null, { assetId: draft.mode === "clone" ? draft.sourceId : undefined, start: draft.start, end: draft.end, transcript: draft.transcript, draftKey: previewKey }); change({ previewId: id }); })}>{auditionAsset ? "再试一个" : "生成试听"}</button></div>
        {audition && <div className="voice-studio-preview">{preview(auditionAsset)}<p className="voice-studio-hint">{userErrorMessage(audition.message, "试听暂未完成，请稍后查看")}</p>{audition.status === "running" && <button className="app-modal-button" onClick={() => void act(() => voiceApi.cancel(audition.id))}>取消试听</button>}{audition.recoverable && <button className="app-modal-button" onClick={() => void act(() => voiceApi.recover(audition.id))}>重试保存试听</button>}</div>}
        <footer className="voice-studio-actions"><small>{draft.mode === "clone" ? "命名后即可保存，试听可选" : "生成试听并命名后保存"}</small><button className="app-modal-button is-primary" disabled={busy || !canSave} onClick={() => void act(async () => {
          const assetId = draft.mode === "clone" ? draft.sourceId : auditionAsset!.id;
          const voice = await voiceApi.save(draft.name, assetId, draft.mode === "clone" ? draft.transcript : "", draft.mode === "clone" ? draft.start : 0, draft.mode === "clone" ? draft.end : Math.min(auditionAsset!.duration ?? 4, 30));
          change({ voiceId: voice.id, sourceId: "", name: "", transcript: "", description: "", previewId: "", start: 0, end: 0 }); setSource(null); go("main"); setNotice("声音已保存，已为你选中");
        })}>保存并使用</button></footer></>}
      {view === "setup" && <><p>{environment?.message || "正在检测本机环境…"}</p>{environment?.gpu && <p className="voice-studio-hint">{environment.gpu}</p>}{environment && environment.phase !== "ready" && <p className="voice-studio-hint">需预留 {gb(environment.required_bytes)}，当前可用 {gb(environment.free_bytes)}</p>}
        {environment?.phase === "installing" && <><progress value={environment.completed_bytes} max={environment.total_bytes} /><small>可以关闭窗口，准备会在后台继续。</small></>}
        <div className="voice-studio-row">{environment?.phase === "ready" ? <button className="app-modal-button is-primary" onClick={() => go("create")}>开始创建声音</button> : environment?.phase === "installing" ? <button className="app-modal-button" onClick={() => void act(async () => setEnvironment(await voiceApi.environment("pause")))}>暂停准备</button> : <button className="app-modal-button is-primary" disabled={busy || !environment?.can_install} onClick={() => void act(async () => setEnvironment(await voiceApi.environment("install")))}>{environment?.phase === "missing" ? "下载并启用" : "继续准备"}</button>}<button className="app-modal-button" disabled={busy || environment?.phase === "installing"} onClick={() => void act(async () => setEnvironment(await voiceApi.environment("check")))}>重新检测</button></div>
        <details><summary>安装位置与详情</summary><p className="voice-studio-path">{environment?.directory}</p><button className="app-modal-button" disabled={busy || environment?.phase === "installing"} onClick={() => void act(async () => { const directory = await open({ directory: true, multiple: false }); if (typeof directory === "string") setEnvironment(await voiceApi.environment("check", directory)); })}>更改安装位置</button><p className="voice-studio-hint">独立安装，不修改系统 Python。下载与模型校验完成后检查运行环境。</p></details>
        <details><summary>连接已有环境</summary><div className="voice-studio-fields">{(["python", "model"] as const).map(field => <label key={field}>{field === "python" ? "Python 程序" : "VoxCPM2 模型目录"}<div className="voice-studio-row"><input readOnly value={config[field]} /><button className="app-modal-button" disabled={busy} onClick={() => void act(async () => { const path = await open({ directory: field === "model", multiple: false }); if (typeof path === "string") setConfig(c => ({ ...c, [field]: path })); })}>选择</button></div></label>)}<button className="app-modal-button" disabled={busy || !config.python || !config.model} onClick={() => void act(async () => { await voiceApi.configure(config); setEnvironment(await voiceApi.environment("check")); })}>连接并检查</button></div></details></>}
      {view === "library" && <><input aria-label="搜索录音" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} placeholder="搜索当前项目的录音" />{library.map(asset => <button key={asset.id} className="voice-studio-library-item" onClick={() => choose(asset)}>{asset.name}<small>{asset.duration?.toFixed(1) ?? "—"} 秒</small></button>)}{more && <button className="app-modal-button" onClick={() => setOffset(n => n + 50)}>加载更多</button>}{!library.length && <p>当前项目没有匹配的录音，可选择本机音频文件。</p>}</>}
      {view === "manage" && selected && <><label>声音名称<input value={rename} onChange={e => setRename(e.target.value)} /></label><button className="app-modal-button" onClick={playSelected}><Play size={15} /> 试听</button><div className="voice-studio-actions"><button className="app-modal-button is-danger" disabled={busy} onClick={() => go("remove")}>删除声音</button><button className="app-modal-button is-primary" disabled={busy || !rename.trim()} onClick={() => void act(async () => { await voiceApi.rename(selected.id, rename); go("main"); })}>保存名称</button></div></>}
      {view === "remove" && selected && <><p>仅从“我的声音”移除。原录音和已经生成的配音会保留。</p><div className="voice-studio-actions"><button className="app-modal-button" onClick={() => go("manage")}>保留</button><button className="app-modal-button is-danger" disabled={busy} onClick={() => void act(async () => { await voiceApi.remove(selected.id); change({ voiceId: "" }); go("main"); })}>删除声音</button></div></>}
    </div>}
    {error && <p className="voice-studio-error" role="alert">{error}</p>}{notice && <p className="voice-studio-notice" role="status">{notice}</p>}
  </ModalShell>;
}
