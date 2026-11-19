import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AudioLines, Pause, Play } from "lucide-react";
import { api } from "../lib/api";
import { materialCatalog } from "../lib/materialCatalog";
import { isAudioPath } from "../lib/audioMedia";
import { audioPreviewKey, audioPreviewSnapshot, playAudioPreview, stopAudioPreview, subscribeAudioPreview } from "../lib/audioPreview";
import { saveMediaAssetToCanvas } from "../lib/videoCollectionCanvas";
import { userErrorMessage } from "../lib/userError";
import { voiceApi, type VoiceSnapshot } from "../lib/voice";
import { defaultVoiceSample, voiceCardClip, voiceCardPreviewKey } from "../lib/voiceCard";
import type { Asset } from "../lib/types";
import type { WorkflowNode, WorkflowStep } from "../lib/canvasWorkflow";
import { VoiceReferenceTrim } from "./VoiceReferenceTrim";
import { AudioWaveform } from "./AudioWaveform";
import { TacticalSelect } from "./TacticalSelect";
import "./VoiceCard.css";

const voicesChanged = "bowerbird:voices-changed";
function useVoiceAsset(id: string | undefined, available: Asset[]) {
  const known = available.find(asset => asset.id === id);
  const [loaded, setLoaded] = useState<Asset>();
  useEffect(() => {
    let active = true;
    if (id && !known) void api.getAssetsByIds([id]).then(([asset]) => { if (active) setLoaded(asset); }).catch(() => {});
    return () => { active = false; };
  }, [id, known]);
  return known ?? (loaded?.id === id ? loaded : undefined);
}
function audio(asset?: Asset) {
  return asset?.store_path && <AudioWaveform assetId={asset.id} path={asset.store_path} name={asset.name}
    version={asset.file_mtime ?? asset.created_at ?? 0} duration={asset.duration} />;
}
export function VoiceCard({ node, projectId, referenceIds, assets, placedAssetIds, step, busy, runBlocked, patch, run }: {
  node: WorkflowNode; projectId: string; referenceIds: string[]; assets: Asset[]; step?: WorkflowStep; busy: boolean;
  placedAssetIds: Set<string>; runBlocked: boolean; patch: (changes: Partial<WorkflowNode>) => void; run: () => void;
}) {
  const settings = node.voice ?? {}, selectedId = settings.id;
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(), [error, setError] = useState("");
  const [acting, setActing] = useState(false), guard = useRef(false);
  const [library, setLibrary] = useState(false), [query, setQuery] = useState(""), [limit, setLimit] = useState(50);
  const [choices, setChoices] = useState<Asset[]>([]), [history, setHistory] = useState(false);
  const [manage, setManage] = useState(false), [rename, setRename] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
  const owner = useRef({});
  const selected = snapshot?.voices.find(v => v.id === selectedId);
  const [playing, setPlaying] = useState(false);
  const sampleKey = selected && audioPreviewKey({ assetId: `voice:${selected.id}`, path: selected.reference, sourceVersion: selected.id });
  useEffect(() => {
    setPlaying(false);
    if (sampleKey) return subscribeAudioPreview(sampleKey, () => {
      const { phase } = audioPreviewSnapshot(sampleKey);
      setPlaying(phase === "playing" || phase === "loading");
    });
  }, [sampleKey]);
  const source = useVoiceAsset(referenceIds.length === 1 ? referenceIds[0] : undefined, assets);
  const recording = source && isAudioPath(source.store_path) ? source : undefined;
  const clip = recording && voiceCardClip(settings, recording);
  const sample = settings.sampleText ?? defaultVoiceSample;
  const key = recording && voiceCardPreviewKey(settings, recording);
  const playable = step?.voiceRequest?.previewKey === key ? step?.voiceRequest?.assetId : undefined;
  const result = useVoiceAsset(selectedId ? node.outputs.image?.assetIds?.[0] : playable, assets);
  const locked = busy || acting;
  useEffect(() => {
    let active = true;
    const refresh = () => void voiceApi.snapshot(projectId).then(s => { if (active) setSnapshot(s); })
      .catch(e => { if (active) setError(userErrorMessage(e, "无法读取角色声音")); });
    refresh();
    window.addEventListener(voicesChanged, refresh);
    const timer = history ? setInterval(refresh, 1800) : undefined;
    return () => { active = false; window.removeEventListener(voicesChanged, refresh); clearInterval(timer); };
  }, [projectId, history, step?.status]);
  useEffect(() => () => { if (selectedId) stopAudioPreview(`voice:${selectedId}`); }, [selectedId]);
  useEffect(() => {
    if (!library) return;
    let active = true;
    void materialCatalog.page({ kind: "all", id: null, projectId, media: "audios", query, generated: null, color: null }, 0, limit)
      .then(list => { if (active) setChoices(list); }).catch(e => { if (active) setError(userErrorMessage(e, "无法读取项目录音")); });
    return () => { active = false; };
  }, [library, projectId, query, limit]);
  async function act(work: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true; setActing(true); setError("");
    try { await work(); } catch (e) { setError(userErrorMessage(e, "声音操作未完成")); }
    finally { guard.current = false; setActing(false); }
  }
  function bind(asset: Asset) {
    if (!isAudioPath(asset.store_path)) throw new Error("请选择音频文件");
    patch({ inputs: { ...node.inputs, image: [{ assetId: asset.id }] }, voice: { ...settings, clip: undefined } });
    setLibrary(false);
  }
  function select(id: string) {
    const inputs = { ...node.inputs };
    if (id) delete inputs.image;
    else delete inputs.text;
    patch({ voice: { ...settings, id: id || undefined }, inputs });
    setManage(false); setConfirmDelete(false); setLibrary(false); setError("");
  }
  return <section className="voice-card" aria-label="角色声音设置" onPointerDown={event => event.stopPropagation()}>
    {(!!snapshot?.voices.length || selectedId) && <div className="voice-card-row">
      <TacticalSelect aria-label="选择角色声音" value={selectedId ?? ""} disabled={locked} onValueChange={select}>
        <option value="">用录音创建声音</option>
        {selectedId && !selected && <option value={selectedId}>已选声音不可用</option>}
        {snapshot?.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
      </TacticalSelect>
      {selected && <><button title="试听音色" aria-label={playing ? "停止试听音色" : "试听音色"} onClick={() => {
        if (playing) stopAudioPreview(`voice:${selected.id}`);
        else playAudioPreview({ assetId: `voice:${selected.id}`, path: selected.reference, sourceVersion: selected.id, duration: selected.duration ?? 30 }, 0, true, owner.current);
      }}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <button title="管理声音" aria-label="管理声音" disabled={locked} onClick={() => { setRename(selected.name); setManage(!manage); setConfirmDelete(false); }}>⋯</button></>}
    </div>}
    {manage && selected && <div className="voice-card-row">
      <input aria-label="声音名称" value={rename} onChange={e => setRename(e.target.value)} />
      <button disabled={locked || !rename.trim()} onClick={() => void act(async () => { await voiceApi.rename(selected.id, rename); window.dispatchEvent(new Event(voicesChanged)); setManage(false); })}>改名</button>
      <button disabled={locked} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void act(async () => { await voiceApi.remove(selected.id); select(""); window.dispatchEvent(new Event(voicesChanged)); }); }}>{confirmDelete ? "确认删除" : "删除"}</button>
    </div>}
    {!selectedId && <>
      {recording && clip && <VoiceReferenceTrim key={recording.id} asset={recording} start={clip.start} end={clip.end} disabled={locked}
        onChange={range => patch({ voice: { ...settings, clip: { ...clip, ...range } } })} />}
      <div className={recording ? "voice-card-row" : "voice-card-drop"}>
        {!recording && <><AudioLines size={20} /><span>{referenceIds.length ? "请选择一段音频" : "拖入参考录音"}</span></>}
        <div className="voice-card-actions"><button disabled={locked} onClick={() => void act(async () => {
          const path = await open({ multiple: false, filters: [{ name: "参考录音", extensions: ["wav","mp3","flac","m4a","ogg"] }] });
          if (typeof path !== "string") return;
          const [asset] = await api.importFiles([path], projectId, true);
          if (!asset) throw new Error("无法导入录音");
          bind(asset);
        })}>{recording ? "更换录音" : "选择文件"}</button><button disabled={locked} onClick={() => setLibrary(!library)}>素材库</button></div>
      </div>
      {library && <div className="voice-card-list"><input aria-label="搜索项目录音" placeholder="搜索录音" value={query} onChange={e => { setQuery(e.target.value); setLimit(50); }} />
        {choices.map(asset => <button key={asset.id} disabled={locked} onClick={() => bind(asset)}>{asset.name}</button>)}
        {!choices.length && <small>没有匹配的录音</small>}{choices.length === limit && <button onClick={() => setLimit(limit + 50)}>更多录音</button>}
      </div>}
      {recording && clip && <>
        <textarea aria-label="试听台词" placeholder="试听台词" disabled={locked} value={sample} onChange={e => patch({ voice: { ...settings, sampleText: e.target.value } })} />
        <button disabled={locked || runBlocked || !sample.trim() || clip.end - clip.start < .999} onClick={run}>生成试听</button>
        {audio(result)}
        <details><summary>录音原文（可选）</summary><textarea aria-label="录音原文" disabled={locked} value={clip.transcript} onChange={e => patch({ voice: { ...settings, clip: { ...clip, transcript: e.target.value } } })} /></details>
        <div className="voice-card-row"><input aria-label="声音名称" placeholder="声音名称" disabled={locked} value={clip.name} onChange={e => patch({ voice: { ...settings, clip: { ...clip, name: e.target.value } } })} />
          <button disabled={locked || !clip.name.trim() || clip.end - clip.start < .999} onClick={() => void act(async () => {
            const voice = await voiceApi.save(clip.name, recording.id, clip.transcript, clip.start, clip.end);
            select(voice.id); window.dispatchEvent(new Event(voicesChanged));
          })}>保存并使用</button></div>
      </>}
    </>}
    {selectedId && <>
      <textarea aria-label="配音台词" placeholder="输入角色要说的话…" disabled={locked} value={node.prompt} onChange={e => patch({ prompt: e.target.value })} />
      <button className="voice-card-primary" disabled={locked || runBlocked || !selected || (!node.prompt.trim() && !node.inputs.text?.length)} onClick={run}>生成配音</button>
      {audio(result)}
    </>}
    {!!snapshot?.jobs.some(j => j.purpose !== "preview") && <details open={history} onToggle={e => setHistory(e.currentTarget.open)}><summary>项目配音</summary>
      {history && <div className="voice-card-list">{snapshot.jobs.filter(job => job.purpose !== "preview").map(job => <div key={job.id}>
        <span>{job.text}</span>{audio(snapshot.assets.find(asset => asset.id === job.asset_id))}
        {job.asset_id && <button disabled={acting} onClick={() => void act(() => voiceApi.export(job.asset_id!))}>导出</button>}
        {job.asset_id && !placedAssetIds.has(job.asset_id) && <button disabled={locked} onClick={() => void act(async () => {
          const asset = snapshot.assets.find(item => item.id === job.asset_id);
          if (!asset) throw new Error("配音素材已移除");
          await saveMediaAssetToCanvas(asset, projectId, `voice:${job.id}`);
        })}>添加到画板</button>}
        {job.voice_id && snapshot.voices.some(v => v.id === job.voice_id) && <button disabled={locked} onClick={() => {
          patch({ voice: { ...settings, id: job.voice_id! }, prompt: job.text, inputs: node.inputs.signal ? { signal: node.inputs.signal } : {} });
          setHistory(false);
        }}>复用台词</button>}
        {job.recoverable && <button disabled={acting} onClick={() => void act(() => voiceApi.recover(job.id))}>重试保存</button>}
        {job.status === "running" && <button disabled={acting} onClick={() => void act(() => voiceApi.cancel(job.id))}>取消</button>}
      </div>)}</div>}
    </details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
