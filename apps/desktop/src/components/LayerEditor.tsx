import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Layers, Loader2, Undo2 } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifySuccess } from "../lib/notify";
import { ModalShell } from "./ModalShell";
import { decodeLayerImage, moveLayer, patchLayer, renderLayerDocument, type ImageLayer, type LayerDocument, type LayerRequest, type LayerWorkspace } from "../lib/layerDocument";
import "./LayerEditor.css";

const empty: LayerWorkspace = { document: null, pending: null };
const activeStatuses = ["uploading", "queued", "leased", "running", "cancel_requested"];

export function LayerEditor() {
  const target = useStore(state => state.layerEditor);
  return target ? <LayerEditorPanel key={target.assetId} assetId={target.assetId} projectId={target.projectId} /> : null;
}

function LayerEditorPanel({ assetId, projectId }: { assetId: string; projectId: string | null }) {
  const close = useStore(state => state.closeLayerEditor);
  const auth = useStore(state => state.cloudAuth);
  const [workspace, setWorkspace] = useState<LayerWorkspace>(empty);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [size, setSize] = useState<LayerRequest["layer_options"]["size"]>("auto");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [history, setHistory] = useState<LayerDocument[]>([]);
  const [prices, setPrices] = useState<{ service: string; available: boolean; credits: number | null }[]>([]);
  const [previewSize, setPreviewSize] = useState({ width: 600, height: 500 });
  const preview = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; layer: ImageLayer; document: LayerDocument; resize: boolean } | null>(null);
  const mounted = useRef(true);
  const stop = useRef(false);
  const doc = workspace.document;
  const selected = doc?.layers.find(layer => layer.id === selectedId);
  const ready = auth?.logged_in && auth.cloud_available;
  const locked = busy || loading || !!workspace.pending;
  const decompositionPrice = prices.find(price => price.service === "image_layer_decompose");
  const editPrice = prices.find(price => price.service === "image_layer_edit");
  const stageWidth = doc ? Math.min(previewSize.width - 64, (previewSize.height - 64) * doc.width / doc.height) : 0;

  useEffect(() => {
    if (!preview.current) return;
    const observer = new ResizeObserver(entries => { const rect = entries[0].contentRect; setPreviewSize({ width: rect.width, height: rect.height }); });
    observer.observe(preview.current); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPrices([]);
    if (ready) void api.layerCloudRequest({ action: "layer_quote" }).then(result => { if (!cancelled) setPrices(result.services ?? []); }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [ready, auth?.user_id]);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void (async () => {
      try {
        const [[asset], saved] = await Promise.all([api.getAssetsByIds([assetId]), api.layerWorkspaceLoad(assetId)]);
        if (!asset?.store_path) throw new Error("素材文件不可用");
        const url = await api.readImageDataUrl(asset.store_path);
        await decodeLayerImage(url);
        if (cancelled) return;
        setSource(url); setName(asset.name); setWorkspace(saved ?? empty);
        const savedLayers = saved?.document?.layers;
        setSelectedId(savedLayers?.[savedLayers.length - 1]?.id ?? "");
        if (saved?.pending) setStatus("存在未完成任务，继续取回会使用原任务，不会重新生成。");
      } catch (error) { if (!cancelled) setError(String(error)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; mounted.current = false; stop.current = true; };
  }, [assetId]);

  function update(next: LayerDocument, checkpoint = true) {
    if (checkpoint && doc) setHistory(previous => [...previous.slice(-29), doc]);
    setWorkspace(previous => ({ ...previous, document: next })); setDirty(true);
  }

  function patch(patch: Partial<ImageLayer>) {
    if (doc && selected) update(patchLayer(doc, selected.id, patch));
  }

  async function save() {
    setBusy(true); setError("");
    try { await api.layerWorkspaceSave(assetId, workspace); setDirty(false); notifySuccess("图层工程已保存，可从原图或合成图右键继续编辑"); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  async function run(pending: NonNullable<LayerWorkspace["pending"]>, initial: LayerWorkspace, create: boolean) {
    if (auth?.user_id !== pending.userId) { setError("请登录提交此任务的账号后继续取回"); return; }
    setBusy(true); setError(""); stop.current = false;
    try {
      let result = await api.layerCloudRequest({ action: "get_by_key", idempotency_key: pending.request.idempotency_key });
      if (result.status === "not_found" && create) result = await api.layerCloudRequest(pending.request);
      while (activeStatuses.includes(result.status)) {
        setStatus(`云端处理中 ${result.progress ?? 0}% · 可以停止等待，稍后继续取回`);
        if (stop.current || !mounted.current) return;
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (stop.current || !mounted.current) return;
        result = await api.layerCloudRequest({ action: "get_by_key", idempotency_key: pending.request.idempotency_key });
      }
      if (result.status === "succeeded") {
        let next = result.layer_result?.document;
        if (pending.layerId) {
          const replacement = result.layer_result?.image;
          if (!replacement || !initial.document) throw new Error("单图层编辑返回内容不完整");
          await decodeLayerImage(replacement);
          next = patchLayer(initial.document, pending.layerId, { dataUrl: replacement });
        }
        if (!next) throw new Error("云端未返回完整图层包");
        await Promise.all(next.layers.map(layer => decodeLayerImage(layer.dataUrl)));
        const saved: LayerWorkspace = { document: next, pending: null };
        // Do not clear pending until the full result is durably local.
        await api.layerWorkspaceSave(assetId, saved);
        setWorkspace(saved); setSelectedId(pending.layerId ?? next.layers[next.layers.length - 1].id);
        setDirty(false); setHistory([]); setStatus("图层已取回并保存到本地");
        void useStore.getState().syncCloudEntitlement();
      } else if (["failed", "cancelled", "artifact_expired", "rejected"].includes(result.status)) {
        const saved = { ...initial, pending: null };
        await api.layerWorkspaceSave(assetId, saved); setWorkspace(saved);
        setError(result.error?.message ?? "任务未完成"); setStatus("");
      } else {
        setError(result.error?.message ?? "任务结果尚无法确认，请保留原任务继续查询");
      }
    } catch (error) { setError(`${String(error)}。原任务信息已保留，可继续取回。`); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function start(operation: "decompose" | "edit") {
    if (!ready || !auth?.user_id || !source || workspace.pending) return;
    setBusy(true); setError("");
    try {
      const image = operation === "edit" ? selected?.dataUrl : source;
      if (!image) throw new Error("请选择待编辑图层");
      const decoded = await decodeLayerImage(image);
      const pixels = decoded.naturalWidth * decoded.naturalHeight;
      if (operation === "decompose" && (pixels < 262144 || pixels > 36000000 || decoded.naturalWidth / decoded.naturalHeight < 1 / 16 || decoded.naturalWidth / decoded.naturalHeight > 16)) throw new Error("拆分图片需为 26 万至 3600 万像素，宽高比在 1:16 至 16:1 之间");
      // PNG keeps the original alpha, including the single-layer AI edit input.
      const canvas = document.createElement("canvas"); canvas.width = decoded.naturalWidth; canvas.height = decoded.naturalHeight;
      canvas.getContext("2d")!.drawImage(decoded, 0, 0);
      const base64 = canvas.toDataURL("image/png").split(",")[1];
      if (base64.length * 3 / 4 > 10 * 1024 * 1024) throw new Error("当前云上传单图上限为 10 MB，请先缩小图片");
      const pending: NonNullable<LayerWorkspace["pending"]> = {
        userId: auth.user_id, layerId: operation === "edit" ? selectedId : null,
        request: { idempotency_key: `layers-${crypto.randomUUID()}`, media: "image", service: operation === "decompose" ? "image_layer_decompose" : "image_layer_edit", prompt: operation === "decompose" ? prompt.trim() : editPrompt.trim(), reference_images: [{ mime: "image/png", base64 }], layer_options: { operation, size: operation === "edit" && size === "auto" ? "2K" : size } },
      };
      const next = { ...workspace, pending };
      await api.layerWorkspaceSave(assetId, next); setWorkspace(next); setDirty(false);
      await run(pending, next, true);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  async function exportImage() {
    if (!doc) return;
    setBusy(true); setError("");
    try {
      await api.layerExport(assetId, doc, await renderLayerDocument(doc), projectId);
      await api.layerWorkspaceSave(assetId, workspace); setDirty(false);
      notifySuccess("合成图片已保存到素材库，并保留可编辑图层");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  function beginDrag(event: React.PointerEvent, layer: ImageLayer, resize: boolean) {
    if (locked || !doc || layer.background) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(layer.id);
    drag.current = { x: event.clientX, y: event.clientY, layer, document: doc, resize };
  }

  function onDrag(event: React.PointerEvent) {
    const current = drag.current; const bounds = stage.current?.getBoundingClientRect();
    if (!current || !bounds) return;
    const dx = (event.clientX - current.x) * current.document.width / bounds.width;
    const dy = (event.clientY - current.y) * current.document.height / bounds.height;
    const scale = Math.max(0.02, 1 + dx / current.layer.width);
    const changed = current.resize ? { width: current.layer.width * scale, height: current.layer.height * scale } : { x: current.layer.x + dx, y: current.layer.y + dy };
    update(patchLayer(current.document, current.layer.id, changed), false);
  }

  function endDrag() {
    if (drag.current) { const original = drag.current.document; setHistory(previous => [...previous.slice(-29), original]); drag.current = null; }
  }

  return <>
    <ModalShell title="分层编辑" eyebrow={name} width="lg" className="layer-editor" preventClose={busy}
      panelProps={{ onKeyDown: event => { if (event.nativeEvent.isComposing) event.stopPropagation(); } }}
      onClose={() => dirty ? setConfirmClose(true) : close()}
      description="拆出独立图层，自由调整后重新组合。图层工程保存在本机。"
      footer={confirmClose ? <><span className="mr-auto text-xs">放弃未保存修改并关闭？</span><button className="app-modal-button" onClick={() => setConfirmClose(false)}>继续编辑</button><button className="app-modal-button is-danger" onClick={close}>放弃修改并关闭</button></> : <><span className="mr-auto text-xs text-muted">{dirty ? "有未保存修改" : ""}</span><button className="app-button" disabled={busy || !doc} onClick={() => void save()}>保存图层工程</button><button className="app-button-primary" disabled={locked || !doc} onClick={() => void exportImage()}>合成图片入库</button></>}>
      <div className="layer-layout">
        <section ref={preview} className="layer-preview" aria-label="图层画布">
          {loading ? <Loader2 className="animate-spin" /> : !doc ? source && <img className="layer-source" src={source} alt="待拆分原图" /> :
            <div ref={stage} className="layer-stage" style={{ width: Math.max(1, stageWidth), height: Math.max(1, stageWidth * doc.height / doc.width) }}>
              {doc.layers.map(layer => layer.visible && <div key={layer.id} data-layer-id={layer.id}
                className={`layer-object ${selectedId === layer.id && !layer.background ? "is-selected" : ""}`}
                style={{ left: `${layer.x / doc.width * 100}%`, top: `${layer.y / doc.height * 100}%`, width: `${layer.width / doc.width * 100}%`, height: `${layer.height / doc.height * 100}%`, cursor: layer.background ? "default" : "move" }}
                onPointerDown={event => beginDrag(event, layer, false)} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
                <img src={layer.dataUrl} alt={layer.name} draggable={false} style={{ opacity: layer.opacity }} />
                {selectedId === layer.id && !layer.background && <button aria-label="等比缩放图层" className="layer-resize" onPointerDown={event => beginDrag(event, layer, true)} />}
              </div>)}
            </div>}
        </section>
        <aside className="layer-controls">
          <div className="flex items-center gap-2"><Layers size={17} /><strong>{doc ? `${doc.layers.length - 1} 个图层 + 底图` : "拆分图像"}</strong>
            <button className="ml-auto" aria-label="撤销" disabled={locked || !history.length} onClick={() => { const previous = history[history.length - 1]; setHistory(history.slice(0, -1)); setWorkspace({ ...workspace, document: previous }); setDirty(true); }}><Undo2 size={16} /></button></div>
          {!doc && <><label>拆分要求（可选）<textarea aria-label="拆分要求" disabled={locked} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="留空自动拆分；也可填写：拆出标题、人物和右下角图标" rows={4} /></label>
            <label>输出尺寸<select aria-label="输出尺寸" disabled={locked} value={size} onChange={event => setSize(event.target.value as typeof size)}>{["auto", "1K", "1.5K", "2K"].map(value => <option key={value} value={value}>{value === "auto" ? "自动匹配" : value}</option>)}</select></label>
            <p className="text-xs text-muted">使用 Seedream 5.0 Pro，通过 Bowerbird Cloud 拆分；费用由云端独立服务档位决定。本地调整不消耗积分。</p>
            <button className="app-button-primary" disabled={locked || !ready || !source || !decompositionPrice?.available} onClick={() => void start("decompose")}>{decompositionPrice?.available ? `开始拆分 · ${decompositionPrice.credits} 积分/次` : "拆分服务待开放"}</button></>}
          {doc && <><div className="layer-list" aria-label="图层列表">{[...doc.layers].reverse().map(layer => <div key={layer.id} className={`layer-row ${selectedId === layer.id ? "is-selected" : ""}`}>
            <button aria-label={`${layer.visible ? "隐藏" : "显示"}${layer.name}`} disabled={locked} onClick={() => update(patchLayer(doc, layer.id, { visible: !layer.visible }))}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
            <button className="layer-select" onClick={() => setSelectedId(layer.id)}><img src={layer.dataUrl} alt="" /><span>{layer.name}</span></button>
          </div>)}</div>
          {selected && <><label>图层名称<input aria-label="图层名称" disabled={locked} value={selected.name} onChange={event => patch({ name: event.target.value })} /></label>
            <p className="text-xs text-muted">{selected.description}</p>
            {!selected.background && <><div className="layer-fields">{(["x", "y", "width", "height"] as const).map((key, index) => <label key={key}>{["X", "Y", "宽", "高"][index]}<input type="number" aria-label={["图层 X", "图层 Y", "图层宽度", "图层高度"][index]} disabled={locked} value={Math.round(selected[key])} min={index > 1 ? 1 : -100000} max={100000} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && (index < 2 || value > 0) && Math.abs(value) <= 100000) patch({ [key]: value }); }} /></label>)}</div>
              <div className="flex gap-2"><button className="app-button" disabled={locked || doc.layers[doc.layers.length - 1]?.id === selectedId} onClick={() => update(moveLayer(doc, selectedId, 1))}><ArrowUp size={14} />上移一层</button><button className="app-button" disabled={locked || doc.layers[1]?.id === selectedId} onClick={() => update(moveLayer(doc, selectedId, -1))}><ArrowDown size={14} />下移一层</button></div></>}
            <label>不透明度 {Math.round(selected.opacity * 100)}%<input type="range" aria-label="不透明度" disabled={locked} min="0" max="100" value={Math.round(selected.opacity * 100)} onChange={event => patch({ opacity: Number(event.target.value) / 100 })} /></label>
            {!selected.background && <><label>AI 修改此图层<textarea aria-label="图层修改要求" disabled={locked} value={editPrompt} onChange={event => setEditPrompt(event.target.value)} rows={2} placeholder="例如：把红色花朵改成蓝色，保持形状" /></label><button className="app-button" disabled={locked || !ready || !editPrompt.trim() || !editPrice?.available} onClick={() => void start("edit")}>{editPrice?.available ? `修改选中图层 · ${editPrice.credits} 积分/次` : "图层修改服务待开放"}</button><p className="text-xs text-muted">仅发送选中透明图层；保留位置与尺寸，云端单独计费。</p></>}
          </>}</>}
          {!ready && <p className="text-xs text-muted">登录 Bowerbird 后可使用云端拆分与 AI 修改。</p>}
          {status && <p role="status" className="text-xs text-muted">{status}</p>}
          {busy && workspace.pending && <button className="app-button" onClick={() => { stop.current = true; setStatus("正在停止等待，原任务继续保留"); }}>停止等待</button>}
          {!busy && workspace.pending && <button className="app-button" disabled={!ready} onClick={() => void run(workspace.pending!, workspace, true)}>继续取回原任务</button>}
          {error && <p role="alert" className="text-xs text-red-400 break-words">{error}</p>}
        </aside>
      </div>
    </ModalShell>
  </>;
}
