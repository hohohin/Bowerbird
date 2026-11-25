import { TacticalSelect } from "./TacticalSelect";
import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Eye, EyeOff, Layers, Loader2, Redo2, Undo2 } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifySuccess } from "../lib/notify";
import { ModalShell } from "./ModalShell";
import { LayerTextControls } from "./LayerTextControls";
import { useLayerViewport } from "./useLayerViewport";
import { exportBytesBase64, exportLayerPsd } from "../lib/layerExport";
import { decodeLayerImage, layerTextFontFamilies, loadLayerTextFonts, moveLayer, packLayerHistory, paintLayerText, parseRecognizedText, patchLayer, patchLayerText, prepareTextImage, renderLayerDocument, renderTextLayer, textFont, textLayerFromRecognition, unpackLayerHistory, type ImageLayer, type LayerDocument, type LayerRequest, type LayerText, type LayerWorkspace, type TextRecognitionPending } from "../lib/layerDocument";
import { LayerImageTooLargeError, layerReferenceBudget, layerReferenceBytes, prepareLayerReference, prepareLocalLayerImage, readDataUrl, verifyLayerImages } from "../lib/layerImages";
import "./LayerEditor.css";

const empty: LayerWorkspace = { document: null, pending: null };
const activeStatuses = ["uploading", "queued", "leased", "running", "cancel_requested"];
const layerLimit = 100;
const resizeCorners = ["bottom-right", "top-left", "top-right", "bottom-left"] as const;
type ResizeCorner = typeof resizeCorners[number];
type LayerGeometryField = "x" | "y" | "width" | "height";
type LayerOperation = LayerRequest["layer_options"]["operation"];
type ConfirmLayerAction = { kind: "resplit" } | { kind: "compress"; operation: LayerOperation };
type LayerPrice = NonNullable<Awaited<ReturnType<typeof api.layerCloudRequest>>["services"]>[number];

function pushHistory(history: LayerDocument[], document: LayerDocument) {
  return [...history.slice(-29), document];
}

function snapToCanvas(position: number, length: number, canvasLength: number, threshold: number) {
  const candidates = [0, canvasLength / 2, canvasLength].flatMap(guide => [0, length / 2, length].map(offset => ({ guide, position: guide - offset })));
  const nearest = candidates.reduce((best, candidate) => Math.abs(candidate.position - position) < Math.abs(best.position - position) ? candidate : best);
  return Math.abs(nearest.position - position) <= threshold ? nearest : { position, guide: null };
}

function centeredLayer(doc: LayerDocument, name: string, dataUrl: string, imageWidth: number, imageHeight: number): ImageLayer {
  const scale = Math.min(1, doc.width * .8 / imageWidth, doc.height * .8 / imageHeight);
  const width = Math.max(1, imageWidth * scale), height = Math.max(1, imageHeight * scale);
  return { id: crypto.randomUUID(), name, dataUrl, description: "", width, height, x: (doc.width - width) / 2, y: (doc.height - height) / 2, opacity: 1, visible: true, background: false };
}

function appendLayer(doc: LayerDocument, layer: ImageLayer): LayerDocument {
  if (doc.layers.length >= layerLimit) throw new Error("当前工程已达到 100 张图层上限（含底图）");
  return { ...doc, layers: [...doc.layers, layer] };
}

function TextPreview({ text, opacity = 1 }: { text: LayerText; opacity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void loadLayerTextFonts(text).then(() => { if (!cancelled && ref.current) paintLayerText(ref.current.getContext("2d")!, text); });
    return () => { cancelled = true; };
  }, [text]);
  return <canvas ref={ref} width={text.boxWidth} height={text.boxHeight} style={{ width: "100%", height: "100%", opacity }} />;
}

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
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [contextReference, setContextReference] = useState("none");
  const [maxImages, setMaxImages] = useState(30);
  const [splitOpen, setSplitOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmLayerAction | null>(null);
  const [size, setSize] = useState<LayerRequest["layer_options"]["size"]>("auto");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cloudWaiting, setCloudWaiting] = useState(false);
  const exiting = useRef(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<LayerDocument[]>([]);
  const [redoHistory, setRedoHistory] = useState<LayerDocument[]>([]);
  const fieldTransaction = useRef<string | null>(null);
  const [numberDraft, setNumberDraft] = useState<{ id: string; key: LayerGeometryField; value: string }>();
  const [quote, setQuote] = useState<{ key: string; services: LayerPrice[] }>();
  const [generationQuote, setGenerationQuote] = useState<{ key: string; price?: LayerPrice }>();
  const [fonts, setFonts] = useState<string[]>(["Microsoft YaHei", "SimSun", "Arial"]);
  const [textPanelId, setTextPanelId] = useState("");
  const textInput = useRef<HTMLTextAreaElement>(null);
  const inlineInput = useRef<HTMLTextAreaElement>(null);
  const inlineChanged = useRef(false);
  const recognitionStarting = useRef(false);
  const [convertLayer, setConvertLayer] = useState<ImageLayer | null>(null);
  const [convertMode, setConvertMode] = useState<"recognize" | "blank">("recognize");
  const [previewSize, setPreviewSize] = useState({ width: 600, height: 500 });
  const [guides, setGuides] = useState<{ x: number | null; y: number | null } | null>(null);
  const preview = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const viewport = useLayerViewport(preview);
  const hitCanvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number; layer: ImageLayer; document: LayerDocument; corner?: ResizeCorner; moved: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const stop = useRef(false);
  const doc = workspace.document;
  const selected = doc?.layers.find(layer => layer.id === selectedId);
  const ready = auth?.logged_in && auth.cloud_available;
  const locked = busy || loading || !!workspace.pending || !!workspace.textPending;
  const editReferenceCount = contextReference === "none" ? 1 : 2;
  const quoteKey = `${auth?.user_id ?? ""}:${size}:${maxImages}:${editReferenceCount}`;
  const generateQuoteKey = `${auth?.user_id ?? ""}:${size}`;
  const prices = ready && quote?.key === quoteKey ? quote.services : [];
  const decompositionPrice = prices.find(price => price.service === "image_layer_decompose");
  const editPrice = prices.find(price => price.service === "image_layer_edit");
  const generationPrice = ready && generationQuote?.key === generateQuoteKey ? generationQuote.price : undefined;
  const canExportAi = /Win/i.test(navigator.platform);
  const foregroundFull = !!doc && doc.layers.length >= layerLimit;
  const stageWidth = doc ? Math.min(previewSize.width - 64, (previewSize.height - 64) * doc.width / doc.height) : 0;

  useEffect(() => {
    let cancelled = false;
    void api.layerFonts().then(names => { if (!cancelled && names.length) setFonts(names); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!busy && textPanelId && textPanelId === selectedId) {
      inlineChanged.current = false;
      inlineInput.current?.focus({ preventScroll: true });
    }
  }, [textPanelId, selectedId, busy]);

  useEffect(() => {
    if (!loading) preview.current?.focus({ preventScroll: true });
  }, [loading]);

  useEffect(() => {
    if (!preview.current) return;
    const observer = new ResizeObserver(entries => { const rect = entries[0].contentRect; setPreviewSize({ width: rect.width, height: rect.height }); });
    observer.observe(preview.current); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const finish = () => endDrag();
    window.addEventListener("blur", finish);
    return () => window.removeEventListener("blur", finish);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (ready) void api.layerCloudRequest({ action: "layer_quote", size, max_images: maxImages, edit_reference_count: editReferenceCount })
      .then(result => { if (!cancelled) setQuote({ key: quoteKey, services: result.layer_protocol === 2 ? result.services ?? [] : [] }); })
      .catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [ready, quoteKey, size, maxImages, editReferenceCount]);

  useEffect(() => {
    let cancelled = false;
    if (ready && generateOpen) void api.layerCloudRequest({ action: "layer_quote", size, edit_reference_count: 0 })
      .then(result => { if (!cancelled) setGenerationQuote({ key: generateQuoteKey, price: result.layer_protocol === 2 ? result.services?.find(price => price.service === "image_layer_edit") : undefined }); })
      .catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [ready, generateQuoteKey, size, generateOpen]);

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
        setHistory(saved ? unpackLayerHistory(saved) : []);
        setRedoHistory(saved ? unpackLayerHistory(saved, "redoDocuments") : []);
        const savedLayers = saved?.document?.layers;
        setSelectedId(savedLayers?.[savedLayers.length - 1]?.id ?? "");
        if (saved?.pending) setStatus("存在未完成任务，继续取回会使用原任务，不会重新生成。");
      } catch (error) { if (!cancelled) setError(String(error)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; mounted.current = false; stop.current = true; };
  }, [assetId]);

  function update(next: LayerDocument, checkpoint = true) {
    if (next === doc) return;
    if (checkpoint) {
      if (doc) setHistory(previous => pushHistory(previous, doc));
      setRedoHistory([]);
    }
    setWorkspace(previous => ({ ...previous, document: next })); setDirty(true);
  }

  function patch(patch: Partial<ImageLayer>) {
    if (doc && selected) update(patchLayer(doc, selected.id, patch));
  }

  function changeLayerField<Key extends "name" | "x" | "y" | "width" | "height" | "opacity">(key: Key, value: ImageLayer[Key]) {
    if (!doc || !selected || selected[key] === value) return;
    const field = `${selected.id}:${key}`;
    update(patchLayer(doc, selected.id, { [key]: value }), fieldTransaction.current !== field);
    fieldTransaction.current = field;
  }

  function endFieldTransaction() {
    fieldTransaction.current = null;
    setNumberDraft(undefined);
  }

  function patchText(patchValue: Partial<LayerText>) {
    if (selected?.text) patch({ text: patchLayerText(selected.text, patchValue) });
  }

  function restoreHistory(redo = false) {
    if (locked || convertLayer || confirmation || !doc) return;
    const original = drag.current?.moved ? drag.current.document : undefined;
    const stack = redo ? redoHistory : history;
    const target = (redo ? undefined : original) ?? stack[stack.length - 1];
    if (!target || (redo && original)) return;
    drag.current = null; setGuides(null); endFieldTransaction();
    if (redo) {
      setRedoHistory(redoHistory.slice(0, -1));
      setHistory(pushHistory(history, doc));
    } else {
      if (!original) setHistory(history.slice(0, -1));
      setRedoHistory(pushHistory(original ? [] : redoHistory, doc));
    }
    setWorkspace({ ...workspace, document: target }); setDirty(true); setStatus("");
    inlineChanged.current = false;
    const targetLayer = target.layers.find(layer => layer.id === selectedId);
    if (!targetLayer && selectedId) setSelectedId(target.layers[target.layers.length - 1]?.id ?? "");
    if (!targetLayer?.text) setTextPanelId("");
  }

  function panelKeyDown(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) { event.stopPropagation(); return; }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "z") return;
    event.stopPropagation();
    // Prompt drafts use their native input undo; layer properties share the panel history.
    const label = (event.target as HTMLElement).getAttribute("aria-label");
    if (label === "拆分要求" || label === "图层修改要求" || label === "透明元素描述") return;
    event.preventDefault(); restoreHistory(event.shiftKey);
  }

  async function startTextRecognition() {
    if (!convertLayer || !doc || locked || !ready || !auth?.user_id || recognitionStarting.current) return;
    recognitionStarting.current = true; setBusy(true); setError(""); setStatus("正在准备文字识别…");
    const layer = convertLayer; setConvertLayer(null);
    try {
      const pending: TextRecognitionPending = { allowCreate: true, idempotencyKey: `layer-text-${crypto.randomUUID()}`, userId: auth.user_id, layerId: layer.id, image: await prepareTextImage(layer.dataUrl) };
      const next = { ...workspace, textPending: pending };
      await persist(next); setWorkspace(next); setDirty(false);
      await recognizeText(pending, next);
    } catch (error) { setError(String(error)); setStatus(""); }
    finally { recognitionStarting.current = false; if (mounted.current) setBusy(false); }
  }

  async function recognizeText(pending: TextRecognitionPending, initial: LayerWorkspace) {
    if (auth?.user_id !== pending.userId) { setError("请登录提交文字识别的账号后继续取回"); return; }
    setBusy(true); setCloudWaiting(true); setError(""); stop.current = false;
    try {
      let result = await api.layerTextRequest({ action: "get_by_key", idempotency_key: pending.idempotencyKey });
      if (!mounted.current || stop.current) return;
      if (useStore.getState().cloudAuth?.user_id !== pending.userId) throw new Error("账号已切换，请登录原账号取回文字");
      if (result.status === "not_found" && pending.allowCreate) {
        result = await api.layerTextRequest({ action: "create", idempotency_key: pending.idempotencyKey, image: pending.image });
      } else if (result.status === "not_found") {
        const next = { ...initial, textPending: null };
        await persist(next); setWorkspace(next);
        setStatus("原识别任务未提交，可双击图层直接转换文字。"); return;
      }
      while (activeStatuses.includes(result.status)) {
        setStatus("正在识别图层文字，完成后自动进入文字与字体编辑。");
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (stop.current || !mounted.current) return;
        if (useStore.getState().cloudAuth?.user_id !== pending.userId) throw new Error("账号已切换，请登录原账号取回文字");
        result = await api.layerTextRequest({ action: "get_by_key", idempotency_key: pending.idempotencyKey });
      }
      if (stop.current || !mounted.current) return;
      setCloudWaiting(false);
      if (result.status === "succeeded") {
        if (!mounted.current || useStore.getState().cloudAuth?.user_id !== pending.userId) return;
        let recognized;
        try { recognized = parseRecognizedText(result.text ?? ""); }
        catch (error) {
          const cleared = { ...initial, textPending: null };
          await persist(cleared); setWorkspace(cleared);
          throw error;
        }
        const layer = initial.document?.layers.find(layer => layer.id === pending.layerId);
        if (!layer || !initial.document) throw new Error("原文字图层已不存在");
        const boxWidth = Math.max(1, Math.min(6000, Math.round(layer.width))), boxHeight = Math.max(1, Math.min(6000, Math.round(layer.height)));
        const text: LayerText = { ...recognized, fontFamily: ["Microsoft YaHei", "微软雅黑", "Arial"].find(font => fonts.includes(font)) ?? fonts[0], fontSize: Math.max(1, Math.min(2000, Math.round(boxHeight / (recognized.content.split("\n").length * 1.2)))), lineHeight: 1.2, letterSpacing: 0, boxWidth, boxHeight };
        await document.fonts.load(textFont(text));
        const context = document.createElement("canvas").getContext("2d")!; context.font = textFont(text);
        const maxWidth = Math.max(...text.content.split("\n").map(line => context.measureText(line).width));
        if (maxWidth > text.boxWidth) text.fontSize = Math.max(1, Math.floor(text.fontSize * text.boxWidth / maxWidth));
        const next = { ...initial, document: patchLayer(initial.document, layer.id, { text, visible: true }), textPending: null };
        const nextHistory = pushHistory(history, initial.document);
        await persist(next, nextHistory, []);
        setHistory(nextHistory); setRedoHistory([]); setWorkspace(next); setDirty(false);
        setSelectedId(layer.id); setTextPanelId(layer.id); setStatus("文字已识别，可直接修改内容和字体；原图片已保留。");
        void useStore.getState().syncCloudEntitlement();
      } else if (["failed", "cancelled", "rejected"].includes(result.status)) {
        const next = { ...initial, textPending: null }; await persist(next); setWorkspace(next);
        setError(result.error?.message ?? "文字识别未完成，原图层已保留"); setStatus("");
      } else setError(result.error?.message ?? "文字识别结果尚无法确认，请继续取回原任务");
    } catch (error) { if (mounted.current) setError(String(error)); }
    finally { if (mounted.current) { setBusy(false); setCloudWaiting(false); } }
  }

  function editText(layer: ImageLayer) {
    if (locked || layer.background || !doc) return;
    setSelectedId(layer.id);
    if (layer.text) { setTextPanelId(layer.id); return; }
    if (layer.textBackup) {
      update(patchLayer(doc, layer.id, { text: layer.textBackup, textBackup: undefined }));
      setTextPanelId(layer.id); return;
    }
    const recognized = textLayerFromRecognition(layer, fonts, doc);
    if (recognized) {
      update(patchLayer(doc, layer.id, { text: recognized.text, visible: true }));
      setTextPanelId(layer.id); setError("");
      setStatus(recognized.missingFonts.length ? `已使用本机默认字体替代：${recognized.missingFonts.join("、")}` : "文字已从拆分结果载入，可直接编辑。");
      return;
    }
    setConvertMode("recognize");
    setConvertLayer(layer);
  }

  function blankLayerText(width: number, height: number): LayerText {
    const boxWidth = Math.max(1, Math.min(6000, Math.round(width)));
    const boxHeight = Math.max(1, Math.min(6000, Math.round(height)));
    return { content: "", fontFamily: ["Microsoft YaHei", "微软雅黑", "PingFang SC", "Arial"].find(font => fonts.includes(font)) ?? fonts[0], fontSize: Math.max(1, Math.min(72, Math.floor(boxHeight / 1.2))), color: "#222222", bold: false, align: "left", lineHeight: 1.2, letterSpacing: 0, boxWidth, boxHeight };
  }

  function convertToText() {
    if (!convertLayer || !doc) return;
    const text = blankLayerText(convertLayer.width, convertLayer.height);
    update(patchLayer(doc, convertLayer.id, { text, visible: true }));
    setSelectedId(convertLayer.id); setTextPanelId(convertLayer.id); setConvertLayer(null);
    setError(""); setStatus("直接在画布上输入文字；右侧可更换本机字体和样式。");
  }

  async function sourceDocument(): Promise<LayerDocument> {
    const image = await prepareLocalLayerImage(source);
    const scale = Math.min(1, 6000 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    return { schemaVersion: 1, width, height, layers: [{ id: "base", name: "底图", description: "", dataUrl: image.dataUrl, width, height, x: 0, y: 0, opacity: 1, visible: true, background: true }] };
  }

  async function addLocalLayer(file?: File) {
    if (locked || !source || foregroundFull) return;
    setBusy(true); setError("");
    try {
      const initial = doc ?? await sourceDocument();
      let layer: ImageLayer;
      if (file) {
        const image = await prepareLocalLayerImage(await readDataUrl(file));
        layer = centeredLayer(initial, file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "导入图片", image.dataUrl, image.width, image.height);
      } else {
        const blank = document.createElement("canvas"); blank.width = blank.height = 1;
        layer = centeredLayer(initial, "文字", blank.toDataURL("image/png"), 320, 80);
        layer.text = blankLayerText(layer.width, layer.height);
      }
      if (!doc) setHistory([initial]);
      update(appendLayer(initial, layer));
      setSelectedId(layer.id);
      setTextPanelId(layer.text ? layer.id : "");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  function duplicateLayer() {
    if (!doc || !selected || selected.background || foregroundFull || locked) return;
    const layer = { ...selected, id: crypto.randomUUID(), name: `${selected.name.slice(0, 195)} 副本`, x: Math.min(100000, selected.x + 12), y: Math.min(100000, selected.y + 12) };
    const layers = [...doc.layers];
    layers.splice(layers.indexOf(selected) + 1, 0, layer);
    update({ ...doc, layers }); setSelectedId(layer.id); setTextPanelId("");
  }

  function removeLayer() {
    if (!doc || !selected || selected.background || locked) return;
    const layers = doc.layers.filter(layer => layer.id !== selected.id);
    setSelectedId(layers[Math.max(0, doc.layers.indexOf(selected) - 1)].id);
    setTextPanelId(""); update({ ...doc, layers });
  }

  async function persist(next: LayerWorkspace, undoHistory = history, redo = redoHistory) {
    await api.layerWorkspaceSave(assetId, { ...next, history: packLayerHistory(next.document, undoHistory, redo) });
    useStore.setState(state => ({ layerWorkspaceIds: new Set([...state.layerWorkspaceIds, assetId]) }));
  }

  async function temporarilyExit() {
    if (exiting.current || loading || convertLayer || confirmation || (busy && !cloudWaiting)) return;
    exiting.current = true;
    // Cloud requests and their undo history are already saved before submission.
    if (cloudWaiting) { stop.current = true; close(); return; }
    setBusy(true); setError("");
    const original = drag.current?.moved ? drag.current.document : undefined;
    const undoHistory = original ? pushHistory(history, original) : history;
    const redo = original ? [] : redoHistory;
    drag.current = null; setGuides(null); setHistory(undoHistory); setRedoHistory(redo);
    try {
      if (dirty || original) await persist(workspace, undoHistory, redo);
      close();
    } catch (error) { setError(`自动保存失败：${String(error)}`); }
    finally { exiting.current = false; if (mounted.current) setBusy(false); }
  }

  async function save() {
    setBusy(true); setError("");
    try { await persist(workspace); setDirty(false); notifySuccess("图层工程已保存，可从原图或合成图右键继续编辑"); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  async function run(pending: NonNullable<LayerWorkspace["pending"]>, initial: LayerWorkspace, create: boolean) {
    if (auth?.user_id !== pending.userId) { setError("请登录提交此任务的账号后继续取回"); return; }
    setBusy(true); setCloudWaiting(true); setError(""); stop.current = false;
    try {
      const checkAccount = () => {
        if (useStore.getState().cloudAuth?.user_id !== pending.userId) throw new Error("账号已切换，请登录原账号继续取回");
      };
      let result = await api.layerCloudRequest({ action: "get_by_key", idempotency_key: pending.request.idempotency_key });
      if (stop.current || !mounted.current) return;
      checkAccount();
      if (result.status === "not_found" && create) result = await api.layerCloudRequest(pending.request);
      while (activeStatuses.includes(result.status)) {
        setStatus(`云端处理中 ${result.progress ?? 0}% · 可以停止等待，稍后继续取回`);
        if (stop.current || !mounted.current) return;
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (stop.current || !mounted.current) return;
        checkAccount();
        result = await api.layerCloudRequest({ action: "get_by_key", idempotency_key: pending.request.idempotency_key });
      }
      if (stop.current || !mounted.current) return;
      checkAccount();
      setCloudWaiting(false);
      if (result.status === "succeeded") {
        let next = result.layer_result?.document;
        const operation = pending.request.layer_options.operation;
        let selectedLayerId = pending.layerId;
        if (operation === "edit" && pending.layerId) {
          const replacement = result.layer_result?.image;
          if (!replacement || !initial.document) throw new Error("单图层编辑返回内容不完整");
          await decodeLayerImage(replacement);
          next = patchLayer(initial.document, pending.layerId, { dataUrl: replacement, text: undefined, textBackup: undefined, textRecognition: undefined });
        } else if (operation === "generate") {
          const generated = result.layer_result?.image;
          if (!generated || !initial.document) throw new Error("透明元素层返回内容不完整");
          const image = await decodeLayerImage(generated);
          const layer = centeredLayer(initial.document, "AI 透明元素", generated, image.naturalWidth, image.naturalHeight);
          next = appendLayer(initial.document, layer);
          selectedLayerId = layer.id;
        }
        if (!next) throw new Error("云端未返回完整图层包");
        if (operation === "decompose") await verifyLayerImages(next.layers);
        checkAccount();
        const saved: LayerWorkspace = { document: next, pending: null };
        // Do not clear pending until the full result is durably local.
        const nextHistory = initial.document ? pushHistory(history, initial.document) : history;
        await persist(saved, nextHistory, []);
        setWorkspace(saved); setSelectedId(selectedLayerId ?? next.layers[next.layers.length - 1]?.id ?? "");
        setDirty(false); setHistory(nextHistory); setRedoHistory([]); setStatus("图层已取回并保存到本地");
        if (operation === "decompose") setSplitOpen(false);
        if (operation === "generate") { setGenerateOpen(false); setGeneratePrompt(""); }
        void useStore.getState().syncCloudEntitlement();
      } else if (["failed", "cancelled", "artifact_expired", "rejected"].includes(result.status)) {
        const saved = { ...initial, pending: null };
        await persist(saved); setWorkspace(saved);
        setError(result.error?.message ?? "任务未完成"); setStatus("");
      } else {
        setError(result.error?.message ?? "任务结果尚无法确认，请保留原任务继续查询");
      }
    } catch (error) { setError(`${String(error)}。原任务信息已保留，可继续取回。`); }
    finally { if (mounted.current) { setBusy(false); setCloudWaiting(false); } }
  }

  async function start(operation: LayerOperation, compress = false) {
    if (!ready || !auth?.user_id || !source || locked) return;
    setBusy(true); setError("");
    try {
      const split = operation === "decompose";
      const initialDocument = operation === "generate" ? doc ?? await sourceDocument() : doc;
      const references: LayerRequest["reference_images"] = [];
      if (split) references.push(await prepareLayerReference(source, true, compress));
      if (operation === "edit") {
        if (!doc || !selected || selected.background) throw new Error("请选择待编辑图层");
        const target = selected.text ? await renderTextLayer(selected.text) : selected.dataUrl;
        const primary = await prepareLayerReference(target, false, compress);
        references.push(primary);
        if (contextReference !== "none") {
          const context = contextReference === "base" ? doc.layers[0].dataUrl : await renderLayerDocument(doc);
          references.push(await prepareLayerReference(context, false, compress, layerReferenceBudget - layerReferenceBytes(primary.base64)));
        }
      }
      if (operation === "generate" && initialDocument!.layers.length >= layerLimit) throw new Error("当前工程已达到 100 张图层上限");
      if (useStore.getState().cloudAuth?.user_id !== auth.user_id) throw new Error("账号已切换，请重新提交图层任务");
      const pending: NonNullable<LayerWorkspace["pending"]> = {
        userId: auth.user_id, layerId: operation === "edit" ? selectedId : null,
        request: {
          idempotency_key: `layers-${crypto.randomUUID()}`, media: "image", service: split ? "image_layer_decompose" : "image_layer_edit",
          prompt: (split ? prompt : operation === "edit" ? editPrompt : generatePrompt).trim(), reference_images: references,
          layer_options: { operation, size: !split && size === "auto" ? "2K" : size, ...(split ? { max_images: maxImages, text_recognition: true } : {}) },
        },
      };
      const next = { ...workspace, document: initialDocument, pending };
      await persist(next); setWorkspace(next); setDirty(false);
      await run(pending, next, true);
    } catch (error) {
      if (error instanceof LayerImageTooLargeError && !compress) setConfirmation({ kind: "compress", operation });
      else setError(String(error));
    }
    finally { setBusy(false); }
  }

  async function exportProject(format: "psd" | "ai") {
    if (!doc || locked) return;
    setBusy(true); setError("");
    try {
      const filename = (name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/, "") || "分层工程").slice(0, 100);
      const path = await saveFileDialog({ defaultPath: `${filename}.${format}`, filters: [{ name: format === "psd" ? "Photoshop 图层工程" : "Adobe Illustrator 工程", extensions: [format] }] });
      if (!path) return;
      setStatus(format === "psd" ? "正在导出 PSD 图层工程…" : "正在调用本机 Illustrator 导出，首次启动可能需要稍候…");
      let warnings = "";
      if (format === "psd") {
        const fonts = [...new Set(doc.layers.flatMap(layer => layer.text ? layerTextFontFamilies(layer.text) : []))];
        const fontNames = await api.layerExportFontNames(fonts);
        await api.layerExportPsd(path, exportBytesBase64(await exportLayerPsd(doc, fontNames)));
      }
      else warnings = await api.layerExportAi(path, doc);
      setStatus(warnings || `${format.toUpperCase()} 工程已导出：${path}`);
      notifySuccess(`${format.toUpperCase()} 工程已导出`);
    } catch (error) { setStatus(""); setError(String(error)); }
    finally { setBusy(false); }
  }

  async function exportImage() {
    if (!doc) return;
    setBusy(true); setError("");
    try {
      const exported = await api.layerExport(assetId, doc, await renderLayerDocument(doc), projectId);
      useStore.setState(state => ({ layerWorkspaceIds: new Set([...state.layerWorkspaceIds, exported.id]) }));
      await persist(workspace); setDirty(false);
      notifySuccess("合成图片已保存到素材库，并保留可编辑图层");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  function beginDrag(event: React.PointerEvent, layer: ImageLayer, corner?: ResizeCorner) {
    if (event.button !== 0 || locked || !doc || layer.background) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(layer.id);
    drag.current = { x: event.clientX, y: event.clientY, layer, document: doc, corner, moved: false };
  }

  function onDrag(event: React.PointerEvent) {
    const current = drag.current; const bounds = stage.current?.getBoundingClientRect();
    if (!current || !bounds) return;
    const dx = (event.clientX - current.x) * current.document.width / bounds.width;
    const dy = (event.clientY - current.y) * current.document.height / bounds.height;
    if (!current.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    current.moved = true;
    const layer = current.layer;
    let changed: Partial<ImageLayer>;
    if (current.corner) {
      const left = current.corner.endsWith("left"), top = current.corner.startsWith("top");
      const diagonal = layer.width ** 2 + layer.height ** 2;
      const delta = (dx * layer.width * (left ? -1 : 1) + dy * layer.height * (top ? -1 : 1)) / diagonal;
      const scale = Math.max(1 / Math.min(layer.width, layer.height), Math.min(100000 / Math.max(layer.width, layer.height), 1 + delta));
      const width = layer.width * scale, height = layer.height * scale;
      changed = { width, height, x: left ? layer.x + layer.width - width : layer.x, y: top ? layer.y + layer.height - height : layer.y };
    } else {
      const x = snapToCanvas(layer.x + dx, layer.width, current.document.width, 6 * current.document.width / bounds.width);
      const y = snapToCanvas(layer.y + dy, layer.height, current.document.height, 6 * current.document.height / bounds.height);
      changed = { x: x.position, y: y.position };
      setGuides({ x: x.guide, y: y.guide });
    }
    if (Object.values(changed).some(value => typeof value === "number" && Math.abs(value) > 100000)) return;
    update(patchLayer(current.document, current.layer.id, changed), false);
  }

  function endDrag() {
    const current = drag.current;
    if (!current) return;
    drag.current = null; setGuides(null);
    if (current.moved) {
      setHistory(previous => pushHistory(previous, current.document));
      setRedoHistory([]);
    }
  }

  function hitLayer(clientX: number, clientY: number): ImageLayer | undefined {
    const bounds = stage.current?.getBoundingClientRect();
    if (!doc || !bounds || clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return;
    if (!hitCanvas.current) { hitCanvas.current = document.createElement("canvas"); hitCanvas.current.width = hitCanvas.current.height = 1; }
    const context = hitCanvas.current.getContext("2d", { willReadFrequently: true })!;
    let rectangleHit: ImageLayer | undefined;
    for (const element of Array.from(stage.current!.querySelectorAll<HTMLElement>(".layer-object")).reverse()) {
      const layer = doc.layers.find(layer => layer.id === element.dataset.layerId);
      if (!layer || layer.background || layer.opacity === 0) continue;
      const rect = element.getBoundingClientRect();
      if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) continue;
      rectangleHit ??= layer;
      // Prefer visible pixels underneath transparent margins, then fall back to the top rectangle.
      if (layer.text) return layer;
      const image = element.querySelector("img");
      if (!image?.complete || !image.naturalWidth) continue;
      context.clearRect(0, 0, 1, 1);
      context.drawImage(image, Math.floor((clientX - rect.left) / rect.width * image.naturalWidth), Math.floor((clientY - rect.top) / rect.height * image.naturalHeight), 1, 1, 0, 0, 1, 1);
      if (context.getImageData(0, 0, 1, 1).data[3] > 8) return layer;
    }
    return rectangleHit;
  }

  function canvasPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".layer-view-tools, .layer-inline-text")) return;
    setTextPanelId("");
    event.currentTarget.focus({ preventScroll: true });
    const corner = (event.target as HTMLElement).closest<HTMLElement>(".layer-resize")?.dataset.corner as ResizeCorner | undefined;
    const layer = corner ? selected : hitLayer(event.clientX, event.clientY);
    if (!layer) { setSelectedId(""); setTextPanelId(""); return; }
    setSelectedId(layer.id);
    beginDrag(event, layer, corner);
  }

  return <>
    <ModalShell title="分层编辑" eyebrow={name} width="lg" className="layer-editor" preventClose={(busy && !cloudWaiting) || !!convertLayer || !!confirmation}
      panelProps={{ ...(convertLayer || confirmation ? { inert: "" } : {}), onKeyDownCapture: panelKeyDown }}
      showCloseButton={false}
      onClose={() => void temporarilyExit()}
      headerActions={<><span className="text-xs text-muted" aria-live="polite">{dirty ? "有未保存的修改" : ""}</span><button className="app-modal-button" disabled={loading || busy} onClick={close}>舍弃修改</button><button className="app-modal-button" data-modal-autofocus disabled={loading || (busy && !cloudWaiting)} onClick={() => void temporarilyExit()}>暂时退出</button></>}
      description="拆出独立图层，自由调整后重新组合。图层工程保存在本机。"
      footer={<><button className="app-button" disabled={locked || !doc} onClick={() => void exportProject("psd")}>导出 PSD</button>{canExportAi && <button className="app-button" disabled={locked || !doc} title="需要 Windows 本机安装 Adobe Illustrator" onClick={() => void exportProject("ai")}>导出 AI（需 Illustrator）</button>}<button className="app-button" disabled={busy || !doc} onClick={() => void save()}>保存图层工程</button><button className="app-button-primary" disabled={locked || !doc} onClick={() => void exportImage()}>合成图片入库</button></>}>
      <div className="layer-layout">
        <section ref={preview} tabIndex={-1} className={`layer-preview ${viewport.spaceHeld ? "is-pan-ready" : ""} ${viewport.panning ? "is-panning" : ""}`} aria-label="图层画布"
          onPointerDownCapture={viewport.onPointerDownCapture} onPointerDown={canvasPointerDown}
          onPointerMove={event => { if (viewport.panning) viewport.onPointerMove(event); else onDrag(event); }}
          onPointerUp={() => { viewport.endPan(); endDrag(); }} onPointerCancel={() => { viewport.endPan(); endDrag(); }} onLostPointerCapture={() => { viewport.endPan(); endDrag(); }}
          onAuxClick={event => { if (event.button === 1) event.preventDefault(); }}
          onDoubleClick={event => { if ((event.target as HTMLElement).closest(".layer-view-tools, .layer-inline-text") || viewport.blocksDoubleClick()) return; const layer = hitLayer(event.clientX, event.clientY); if (layer) editText(layer); }}>
          <div className="layer-view-tools" role="toolbar" aria-label="画布视图">
            <button aria-label="缩小画布" disabled={loading || viewport.view.zoom <= .25} onClick={() => viewport.zoomBy(1 / 1.25)}>−</button>
            <output aria-label="画布缩放">{Math.round(viewport.view.zoom * 100)}%</output>
            <button aria-label="放大画布" disabled={loading || viewport.view.zoom >= 8} onClick={() => viewport.zoomBy(1.25)}>＋</button>
            <button disabled={loading} onClick={viewport.reset}>适应窗口</button>
            <span>滚轮缩放 · 空格 / 中键拖动</span>
          </div>
          {loading ? <Loader2 className="animate-spin" /> : !doc ? source && <img className="layer-source" src={source} alt="待拆分原图" draggable={false} style={{ transform: viewport.transform }} /> :
            <div ref={stage} className="layer-stage" style={{ width: Math.max(1, stageWidth), height: Math.max(1, stageWidth * doc.height / doc.width), transform: viewport.transform }}>
              {doc.layers.map(layer => layer.visible && <div key={layer.id} data-layer-id={layer.id}
                className={`layer-object ${selectedId === layer.id && !layer.background ? "is-selected" : ""}`}
                style={{ left: `${layer.x / doc.width * 100}%`, top: `${layer.y / doc.height * 100}%`, width: `${layer.width / doc.width * 100}%`, height: `${layer.height / doc.height * 100}%`, cursor: layer.background ? "default" : "move", outlineWidth: 2 / viewport.view.zoom }}
                >
                {layer.text && textPanelId === layer.id && selectedId === layer.id ? <textarea ref={inlineInput} aria-label="画布文字内容" className="layer-inline-text" value={layer.text.content} placeholder="输入文字" maxLength={5000} spellCheck={false} disabled={locked}
                  style={{ width: layer.text.boxWidth, height: layer.text.boxHeight, transform: `scale(${layer.width / layer.text.boxWidth * stageWidth / doc.width}, ${layer.height / layer.text.boxHeight * stageWidth / doc.width})`, fontFamily: `${JSON.stringify(layer.text.fontFamily)}, sans-serif`, fontSize: layer.text.fontSize, fontWeight: layer.text.bold ? 700 : 400, fontStyle: layer.text.italic ? "italic" : "normal", textDecorationLine: [layer.text.underline && "underline", layer.text.strikethrough && "line-through"].filter(Boolean).join(" ") || "none", textShadow: layer.text.shadow ? "1px 1px 2px #0008" : undefined, lineHeight: layer.text.lineHeight, letterSpacing: layer.text.letterSpacing, textAlign: layer.text.align, color: layer.text.color, opacity: layer.opacity }}
                  onChange={event => { update(patchLayer(doc, layer.id, { text: patchLayerText(layer.text!, { content: event.target.value }) }), !inlineChanged.current); inlineChanged.current = true; }}
                  onBlur={() => setTextPanelId("")}
                  onKeyDown={event => { event.stopPropagation(); if (!event.nativeEvent.isComposing && (event.key === "Escape" || event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); setTextPanelId(""); preview.current?.focus({ preventScroll: true }); } }}
                /> : layer.text ? <TextPreview text={layer.text} opacity={layer.opacity} /> : <img src={layer.dataUrl} alt={layer.name} draggable={false} style={{ opacity: layer.opacity }} />}
                {selectedId === layer.id && !layer.background && textPanelId !== layer.id && resizeCorners.map((corner, index) => <button key={corner} tabIndex={-1} aria-label={["等比缩放图层", "从左上角等比缩放", "从右上角等比缩放", "从左下角等比缩放"][index]} data-corner={corner} className="layer-resize" style={{ transform: `scale(${1 / viewport.view.zoom})`, transformOrigin: corner.replace("-", " ") }} />)}
              </div>)}
              {guides?.x != null && <div className="layer-snap-guide is-vertical" style={{ left: `${guides.x / doc.width * 100}%`, width: 1 / viewport.view.zoom }} />}
              {guides?.y != null && <div className="layer-snap-guide is-horizontal" style={{ top: `${guides.y / doc.height * 100}%`, height: 1 / viewport.view.zoom }} />}
            </div>}
        </section>
        <aside className="layer-controls">
          <div className="flex items-center gap-2"><Layers size={17} /><strong>{doc ? `${doc.layers.length - 1} 个图层 + 底图` : "拆分图像"}</strong>
            <button className="ml-auto" aria-label="撤销" title="撤销（Ctrl+Z / Cmd+Z）" disabled={locked || !history.length} onClick={() => restoreHistory()}><Undo2 size={16} /></button>
            <button aria-label="重做" title="重做（Ctrl+Shift+Z / Cmd+Shift+Z）" disabled={locked || !redoHistory.length} onClick={() => restoreHistory(true)}><Redo2 size={16} /></button></div>
          {doc && !splitOpen && <button className="app-button" disabled={locked} onClick={() => setSplitOpen(true)}>重新拆分</button>}
          {(!doc || splitOpen) && <><label>拆分要求（可选）<textarea aria-label="拆分要求" disabled={locked} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="留空自动拆分；也可填写：拆出标题、人物和右下角图标" rows={4} /></label>
            <label>输出尺寸<TacticalSelect menuClassName="layer-select-menu" aria-label="输出尺寸" disabled={locked} value={size} onValueChange={value => setSize(value as typeof size)}>{["auto", "1K", "1.5K", "2K"].map(value => <option key={value} value={value}>{value === "auto" ? "自动匹配" : value}</option>)}</TacticalSelect></label>
            <label>最大图层数（含底图）<TacticalSelect menuClassName="layer-select-menu" aria-label="最大图层数" disabled={locked} value={String(maxImages)} onValueChange={value => setMaxImages(Number(value))}>{[16, 30, 60, 100].map(value => <option key={value} value={String(value)}>{value} 张</option>)}</TacticalSelect></label>
            <p className="text-xs text-muted" aria-live="polite">Seedream 5.5 · 最多预留 {decompositionPrice?.credits ?? "—"} Bcoin。按实际输出结算，未用额度退回。{decompositionPrice?.small_layer_cost != null && decompositionPrice.large_layer_cost != null && `每张 ≤261 万像素 ${decompositionPrice.small_layer_cost} Bcoin，超过为 ${decompositionPrice.large_layer_cost} Bcoin。`}{!!decompositionPrice?.input_credits && `输入图 ${decompositionPrice.input_credits} Bcoin。`}</p>
            <div className="flex flex-wrap gap-2"><button className="app-button-primary" disabled={locked || !ready || !source || !decompositionPrice?.available} onClick={() => doc ? setConfirmation({ kind: "resplit" }) : void start("decompose")}>{decompositionPrice?.available ? doc ? "开始重新拆分" : "开始拆分" : "拆分服务待开放"}</button>{doc && <button className="app-button" disabled={locked} onClick={() => setSplitOpen(false)}>收起</button>}</div></>}
          <div className="flex flex-wrap gap-2" role="group" aria-label="添加图层">
            <button className="app-button" disabled={locked || foregroundFull || !source} onClick={() => void addLocalLayer()}>新建空白文字层</button>
            <button className="app-button" disabled={locked || foregroundFull || !source} onClick={() => fileInput.current?.click()}>导入本地图片</button>
            <input ref={fileInput} type="file" accept="image/*" aria-label="导入图层图片" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void addLocalLayer(file); }} />
            <button className="app-button" disabled={locked || foregroundFull || !source || !editPrice?.available} aria-expanded={generateOpen} onClick={() => setGenerateOpen(open => !open)}>AI 生成透明元素层</button>
          </div>
          {generateOpen && <><label>透明元素描述<textarea aria-label="透明元素描述" value={generatePrompt} disabled={locked} onChange={event => setGeneratePrompt(event.target.value)} rows={2} placeholder="例如：带水珠的半透明玻璃花瓶" /></label>
            <button className="app-button" disabled={locked || foregroundFull || !generatePrompt.trim() || !generationPrice?.available} onClick={() => void start("generate")}>生成透明元素</button>
            <p className="text-xs text-muted" aria-live="polite">预计 {generationPrice?.credits ?? "—"} Bcoin，生成后添加为新图层。</p></>}
          {doc && <><div className="layer-list" aria-label="图层列表">{[...doc.layers].reverse().map(layer => <div key={layer.id} className={`layer-row ${selectedId === layer.id ? "is-selected" : ""}`}>
            <button aria-label={`${layer.visible ? "隐藏" : "显示"}${layer.name}`} disabled={locked} onClick={() => update(patchLayer(doc, layer.id, { visible: !layer.visible }))}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
            <button className="layer-select" title={layer.background ? undefined : "双击编辑文字"} onClick={() => setSelectedId(layer.id)} onDoubleClick={() => editText(layer)}><span className="layer-thumbnail">{layer.text ? <TextPreview text={layer.text} /> : <img src={layer.dataUrl} alt="" loading="lazy" />}</span><span>{layer.text ? "T · " : ""}{layer.name}</span></button>
          </div>)}</div>
          {selected && <><label>图层名称<input aria-label="图层名称" disabled={locked} value={selected.name} maxLength={200} onBlur={endFieldTransaction} onChange={event => changeLayerField("name", event.target.value)} /></label>
            <p className="text-xs text-muted">{selected.description}</p>
            {!selected.background && !selected.text && <><p className="text-xs text-muted">{selected.textBackup ? "已保留之前的文字内容、字体和样式，可直接切回文字编辑。" : selected.textRecognition ? "可直接使用拆分时识别的文字，本地转换不消耗积分。" : "可调用云端识别文字，或创建空白文字对象。"}</p><button className="app-button" disabled={locked} onClick={() => editText(selected)}>{selected.textBackup ? "切换为文字图层" : "转为可编辑文字"}</button></>}
            {selected.text && <LayerTextControls text={selected.text} fonts={fonts} locked={locked} inputRef={textInput} patch={patchText} restore={() => { patch({ textBackup: selected.text, text: undefined }); setTextPanelId(""); }} />}
            {!selected.background && <><div className="layer-fields">{(["x", "y", "width", "height"] as const).map((key, index) => <label key={key}>{["X", "Y", "宽", "高"][index]}<input type="number" aria-label={["图层 X", "图层 Y", "图层宽度", "图层高度"][index]} disabled={locked} value={numberDraft?.id === selected.id && numberDraft.key === key ? numberDraft.value : Math.round(selected[key])} min={index > 1 ? 1 : -100000} max={100000} onBlur={endFieldTransaction} onChange={event => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value) && (index < 2 || value > 0) && Math.abs(value) <= 100000) {
                setNumberDraft(undefined);
                changeLayerField(key, value);
              } else setNumberDraft({ id: selected.id, key, value: event.target.value });
            }} /></label>)}</div>
              <div className="flex flex-wrap gap-2"><button className="app-button" disabled={locked || doc.layers[doc.layers.length - 1]?.id === selectedId} onClick={() => update(moveLayer(doc, selectedId, 1))}><ArrowUp size={14} />上移一层</button><button className="app-button" disabled={locked || doc.layers[1]?.id === selectedId} onClick={() => update(moveLayer(doc, selectedId, -1))}><ArrowDown size={14} />下移一层</button><button className="app-button" disabled={locked || foregroundFull} onClick={duplicateLayer}>复制图层</button><button className="app-button" disabled={locked} onClick={removeLayer}>删除图层</button></div></>}
            <label>不透明度 {Math.round(selected.opacity * 100)}%<input type="range" aria-label="不透明度" disabled={locked} min="0" max="100" value={Math.round(selected.opacity * 100)} onBlur={endFieldTransaction} onPointerDown={endFieldTransaction} onPointerUp={endFieldTransaction} onPointerCancel={endFieldTransaction} onChange={event => changeLayerField("opacity", Number(event.target.value) / 100)} /></label>
            {!selected.background && <><label>AI 修改此图层<textarea aria-label="图层修改要求" disabled={locked} value={editPrompt} onChange={event => setEditPrompt(event.target.value)} rows={2} placeholder="例如：把红色花朵改成蓝色，保持形状" /></label>
              <label>上下文参考<TacticalSelect menuClassName="layer-select-menu" aria-label="图层修改上下文" disabled={locked} value={contextReference} onValueChange={setContextReference}><option value="none">仅选中图层</option><option value="base">附带底图</option><option value="composite">附带当前合成图</option></TacticalSelect></label>
              <button className="app-button" disabled={locked || !ready || !editPrompt.trim() || !editPrice?.available} onClick={() => void start("edit")}>{editPrice?.available ? "修改选中图层" : "图层修改服务待开放"}</button><p className="text-xs text-muted" aria-live="polite">预计 {editPrice?.credits ?? "—"} Bcoin。修改后保留图层位置与尺寸。</p></>}
          </>}</>}
          {!ready && <p className="text-xs text-muted">登录 Bowerbird 后可使用云端拆分与 AI 修改。</p>}
          {status && <p role="status" className="text-xs text-muted">{status}</p>}
          {busy && (workspace.pending || workspace.textPending) && <button className="app-button" onClick={() => { stop.current = true; setStatus("正在停止等待，原任务继续保留"); }}>停止等待</button>}
          {!busy && workspace.textPending && <button className="app-button" disabled={!ready} onClick={() => void recognizeText(workspace.textPending!, workspace)}>继续取回文字识别</button>}
          {!busy && workspace.pending && <button className="app-button" disabled={!ready} onClick={() => void run(workspace.pending!, workspace, true)}>继续取回原任务</button>}
          {error && <p role="alert" className="text-xs text-red-400 break-words">{userErrorMessage(error, "图层操作未完成，请稍后重试。")}</p>}
        </aside>
      </div>
    </ModalShell>
    {confirmation && <ModalShell title={confirmation.kind === "resplit" ? "重新拆分原图？" : "压缩后上传？"} className="layer-convert-confirm" onClose={() => setConfirmation(null)}
      footer={<><button className="app-modal-button" data-modal-autofocus onClick={() => setConfirmation(null)}>取消</button><button className="app-modal-button is-primary" onClick={() => { const action = confirmation; setConfirmation(null); void start(action.kind === "resplit" ? "decompose" : action.operation, action.kind === "compress"); }}>{confirmation.kind === "resplit" ? "确认重新拆分" : "安全压缩后上传"}</button></>}>
      <p className="text-sm text-muted">{confirmation.kind === "resplit" ? "结果取回后会替换当前图层。可以撤销，恢复这次拆分前的工程。" : "图片超出云端上传大小限制。上传副本会按需等比缩小并保留透明通道。原件和本地图层保留原始尺寸。"}</p>
    </ModalShell>}
    {convertLayer && <ModalShell title="转为可编辑文字" className="layer-convert-confirm" onClose={() => setConvertLayer(null)}
      footer={<><button className="app-modal-button" data-modal-autofocus onClick={() => setConvertLayer(null)}>取消</button><button className="app-modal-button" disabled={convertMode === "recognize" && !ready} onClick={() => convertMode === "recognize" ? void startTextRecognition() : convertToText()}>确认</button></>}>
      <div className="layer-convert-tabs" role="tablist" aria-label="文字转换方式">
        {(["recognize", "blank"] as const).map(mode => <button key={mode} type="button" role="tab" id={`layer-convert-tab-${mode}`} aria-controls={`layer-convert-panel-${mode}`} aria-selected={convertMode === mode} tabIndex={convertMode === mode ? 0 : -1} onClick={() => setConvertMode(mode)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "recognize" : event.key === "End" ? "blank" : mode === "recognize" ? "blank" : "recognize";
          setConvertMode(next); document.getElementById(`layer-convert-tab-${next}`)?.focus();
        }}>{mode === "recognize" ? "识别文字后编辑（云端）" : "创建空白文字对象"}</button>)}
      </div>
      <div className="layer-convert-description" role="tabpanel" id={`layer-convert-panel-${convertMode}`} aria-labelledby={`layer-convert-tab-${convertMode}`}>
        <p>{convertMode === "recognize" ? "保留识别到的文字，尝试匹配颜色与粗细，之后可在画布修改。需要登录 Bowerbird，无法完整复刻原图特效。" : "把该图层转变为空白文字对象（沿用框体）。转变后会丢失原图样式及文本内容。可使用本机字体进行替换。"}</p>
        {convertMode === "recognize" && !ready && <div className="mt-3 text-xs text-muted">当前未登录，登录后可识别文字。</div>}
      </div>
    </ModalShell>}
  </>;
}
