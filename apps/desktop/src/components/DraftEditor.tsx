import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, Brush, Check, Circle, Copy, Crop, Eraser, Eye, EyeOff, Hand, ImagePlus, Lasso, Layers, Lock, Maximize, MousePointer2, MoveUpRight, PaintBucket, Pipette, Plus, Redo2, Save, Scan, Square, Trash2, Type, Undo2, Unlock, X } from "lucide-react";
import { useStore, type DraftEditorRequest } from "../store";
import { api } from "../lib/api";
import { notifySuccess } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { ModalShell } from "./ModalShell";
import { useLayerViewport } from "./useLayerViewport";
import { DraftBrushStroke, applyPixelPatches, type BrushPoint, type PixelPatch } from "../lib/draftBrush";
import { fitDraftCropRatio, resizeDraftCrop, setDraftCropSize, type DraftCropHandle } from "../lib/draftCrop";
import { useDraftLibrary } from "./useDraftLibrary";
import { useDraftBrushPreferences } from "./useDraftBrushPreferences";
import { DraftCropPreview } from "./DraftCropPreview";
import { DraftCropOverlay } from "./DraftCropOverlay";
import { appendDraftLassoPoint, clipDraftSelection, combineDraftSelection, createDraftLasso, draftSelectionSvgPath, invertDraftSelection, type DraftSelection, type DraftSelectionMode } from "../lib/draftSelection";
import { DraftBrushSizeInput } from "./DraftBrushSizeInput";
import { stepDraftBrushSize } from "../lib/draftBrushSize";
import { DraftColorPanel } from "./DraftColorPanel";
import { DraftHistory } from "../lib/draftHistory";
import { checkDraftBudget, draftAsLayerDocument, draftHit, draftLayerSelection, draftPng, draftSelection, duplicateDraftLayer, importedDraftLayer, newDraftDocument, openDraftDocument, paintDraft, rasterLayer, cropDraftDocument, serializeDraft, type DraftRect, type DraftSurface, type DraftWorkingDocument } from "../lib/draftDocument";
import { exportBytesBase64, exportLayerPsd } from "../lib/layerExport";
import { decodeLayerImage, type LayerText } from "../lib/layerDocument";
import "./DraftEditor.css";

type Tool = "brush" | "eraser" | "move" | "text" | "eyedropper" | "select" | "lasso" | "crop" | "rect" | "ellipse" | "arrow";
type Point = { x: number; y: number };
type Gesture = { id: number; start: Point; last: Point; before: DraftWorkingDocument; layer?: DraftSurface;
  kind: "brush" | "move" | "resize" | "select" | "lasso" | "crop" | "rect" | "ellipse" | "arrow"; stroke?: DraftBrushStroke; cropRect?: DraftRect; cropHandle?: DraftCropHandle; lassoPoints?: Point[]; selectionMode?: DraftSelectionMode; selectionBefore?: DraftSelection | null };
const TOOLS = [
  ["move", "移动", "V", MousePointer2], ["brush", "画笔", "B", Brush], ["eraser", "橡皮", "E", Eraser],
  ["eyedropper", "吸管", "I", Pipette], ["select", "选区", "M", Scan], ["lasso", "自由选区", "L", Lasso], ["crop", "裁剪", "C", Crop],
  ["text", "文字", "T", Type], ["rect", "矩形", "U", Square], ["ellipse", "椭圆", "", Circle], ["arrow", "箭头", "", MoveUpRight],
] as const;
const typing = (node: EventTarget | null) => node instanceof HTMLElement && !!node.closest("input,textarea,select,[contenteditable=true],[data-draft-color-panel]");
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const metadataBytes = (doc: DraftWorkingDocument) => JSON.stringify(doc, (key, value) => key === "canvas" ? undefined : value).length * 2;

function SelectionOutline({ path, zoom, preview = false, lasso = false }: { path: string; zoom: number; preview?: boolean; lasso?: boolean }) {
  // vector-effect handles viewBox fitting; the outer CSS zoom still needs compensation.
  return <g className={`draft-selection-outline${lasso ? " draft-lasso-preview" : ""}`} style={{ "--draft-selection-zoom": zoom } as CSSProperties} aria-hidden="true">
    <path className="draft-selection-base" d={path} vectorEffect="non-scaling-stroke" />
    <path className="draft-selection-ants" data-draft-selection={preview ? undefined : true} data-draft-selection-preview={preview ? true : undefined} d={path} vectorEffect="non-scaling-stroke" />
  </g>;
}

export function DraftEditor() {
  const request = useStore(state => state.draftEditor);
  return request ? <DraftEditorPanel key={`${request.assetId ?? "new"}:${request.projectId ?? ""}`} request={request} /> : null;
}

function DraftEditorPanel({ request }: { request: DraftEditorRequest }) {
  const close = useStore(state => state.closeDraftEditor);
  const [epoch, setEpoch] = useState(0);
  const [initialDocument] = useState(() => request.assetId ? null : newDraftDocument(1600, 1200, false));
  const working = useRef<DraftWorkingDocument | null>(initialDocument);
  const history = useRef(new DraftHistory());
  const revision = useRef(0), savedRevision = useRef(0);
  const saveAttempt = useRef<{ revision: number; id: string } | null>(null);
  const [selectedId, setSelectedId] = useState(initialDocument?.layers[initialDocument.layers.length - 1]?.id ?? "");
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColorState] = useState("#222222");
  const foreground = useRef(color);
  function setColor(value: string) { foreground.current = value; setColorState(value); }
  const { size, setSize, hardness, setHardness, opacity, setOpacity, smoothing, setSmoothing, pressure, setPressure, inertia, setInertia } = useDraftBrushPreferences(tool === "eraser" ? "eraser" : "brush");
  const [selection, setSelection] = useState<DraftSelection | null>(null);
  const [selectionMode, setSelectionMode] = useState<DraftSelectionMode>("replace");
  const selectionPath = useMemo(() => selection ? draftSelectionSvgPath(selection) : "", [selection]);
  const [lassoPreview, setLassoPreview] = useState<Point[] | null>(null);
  const [rubber, setRubber] = useState<{ kind: Gesture["kind"]; a: Point; b: Point } | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const cursorPosition = useRef<Point | null>(null);
  const [loading, setLoading] = useState(!!request.assetId), [busy, setBusy] = useState(false);
  const busyRef = useRef(false), mounted = useRef(true);
  const [error, setError] = useState("");
  const [closeConfirm, setCloseConfirm] = useState(false), [showLayers, setShowLayers] = useState(true);
  const [cropRect, setCropRect] = useState<DraftRect | null>(null);
  const [cropRatio, setCropRatio] = useState("free");
  const [cropViewBounds, setCropViewBounds] = useState<DraftRect | null>(null);
  const [altHeld, setAltHeld] = useState(false);
  const [editingText, setEditingText] = useState("");
  const textBefore = useRef<DraftWorkingDocument | null>(null);
  const propertyBefore = useRef<DraftWorkingDocument | null>(null);
  const [fonts, setFonts] = useState(["Arial", "PingFang SC", "Microsoft YaHei", "sans-serif"]);
  const preview = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), composite = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null), inlineText = useRef<HTMLTextAreaElement>(null);
  const closeDialog = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null), frame = useRef(0);
  const cursorCircle = useRef<SVGCircleElement>(null);
  const damage = useRef<DraftRect | null | undefined>(undefined);
  const library = useDraftLibrary({ projectId: request.projectId, disabled: busy || loading || closeConfirm,
    onImportFiles: importFiles, onError: reason => fail(reason, "导入素材失败，请重试") });
  const interactionBusy = busy || library.importing;
  const viewport = useLayerViewport(preview, !loading && !!working.current && !library.open && !interactionBusy && !closeConfirm);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const doc = working.current;
  const selected = doc?.layers.find(layer => layer.id === selectedId);
  const pendingCrop = !!doc && !!cropRect && (cropRect.x !== 0 || cropRect.y !== 0 || cropRect.width !== doc.width || cropRect.height !== doc.height);
  const dirty = revision.current !== savedRevision.current || pendingCrop;
  const fitBounds = tool === "crop" && cropViewBounds ? cropViewBounds : doc;
  const margin = tool === "crop" ? 128 : 64;
  const fit = fitBounds ? Math.max(.01, Math.min((viewportSize.width - margin) / fitBounds.width, (viewportSize.height - margin) / fitBounds.height, 1)) : 1;
  const effectiveScale = fit * viewport.view.zoom;

  function fail(reason: unknown, fallback = "草稿操作失败，请重试") {
    console.error("Draft editor:", reason);
    setError(userErrorMessage(reason, fallback));
  }
  function repaint(rect?: DraftRect) {
    if (!rect) damage.current = null;
    else if (damage.current !== null) {
      const old = damage.current;
      damage.current = old ? { x: Math.min(old.x, rect.x), y: Math.min(old.y, rect.y),
        width: Math.max(old.x + old.width, rect.x + rect.width) - Math.min(old.x, rect.x),
        height: Math.max(old.y + old.height, rect.y + rect.height) - Math.min(old.y, rect.y) } : rect;
    }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (working.current && composite.current) paintDraft(composite.current, working.current, damage.current ?? undefined);
      damage.current = undefined;
    });
  }
  function refresh(next = working.current, changed = false) {
    working.current = next;
    if (changed) revision.current++;
    setEpoch(n => n + 1); repaint();
  }
  function record(before: DraftWorkingDocument, after: DraftWorkingDocument, bytes = 0) {
    if (before === after) return;
    checkDraftBudget(after);
    history.current.push({ bytes: Math.max(bytes, metadataBytes(before) + metadataBytes(after)),
      undo: () => { working.current = before; }, redo: () => { working.current = after; } });
    refresh(after, true);
  }
  function commit(next: DraftWorkingDocument, bytes = 0) {
    const before = working.current;
    if (!before) return;
    try { record(before, next, bytes); } catch (e) { fail(e); }
  }
  function patchLayer(id: string, values: Partial<DraftSurface>, checkpoint = true) {
    if (checkpoint) cancelGesture();
    const current = working.current;
    if (!current) return;
    const next = { ...current, layers: current.layers.map(layer => layer.id === id ? { ...layer, ...values } : layer) };
    if (checkpoint) commit(next); else refresh(next);
  }
  function addLayer(layer: DraftSurface) {
    cancelGesture();
    const current = working.current;
    if (!current) return;
    const next = { ...current, layers: [...current.layers, layer] };
    checkDraftBudget(next); record(current, next, layer.canvas.width * layer.canvas.height * 4);
    setSelectedId(layer.id);
  }
  function cropAspect(value = cropRatio) {
    if (value === "free") return null;
    if (value === "original") return working.current ? working.current.width / working.current.height : null;
    const [width, height] = value.split(":").map(Number); return width / height;
  }
  function frameCrop(rect: DraftRect) {
    const current = working.current;
    if (!current) return;
    const x = Math.min(0, rect.x), y = Math.min(0, rect.y);
    setCropViewBounds({ x, y, width: Math.max(current.width, rect.x + rect.width) - x,
      height: Math.max(current.height, rect.y + rect.height) - y });
  }
  function changeCropSize(axis: "width" | "height", value: number) {
    if (!cropRect || !Number.isFinite(value)) return;
    const next = setDraftCropSize(cropRect, axis, value, cropAspect());
    setCropRect(next); frameCrop(next);
  }
  function changeCropRatio(value: string) {
    if (!cropRect) return;
    setCropRatio(value);
    const next = fitDraftCropRatio(cropRect, cropAspect(value));
    setCropRect(next); frameCrop(next);
  }
  function applyCrop() {
    if (busyRef.current || !working.current || !cropRect || gesture.current) return false;
    finishText(); finishProperty();
    try {
      const before = working.current, next = cropDraftDocument(before, cropRect);
      const bytes = next.layers.reduce((total, layer) => {
        const old = before.layers.find(previous => previous.id === layer.id);
        return total + (old?.canvas === layer.canvas ? 0 : (layer.canvas.width * layer.canvas.height
          + (old ? old.canvas.width * old.canvas.height : 0)) * 4);
      }, 0);
      record(before, next, bytes); setSelection(null); setCropRect(null); setCropViewBounds(null);
      setTool("move"); viewport.reset(); setError(""); return true;
    } catch (e) { fail(e); return false; }
  }

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (request.assetId) void (async () => {
      try {
        const saved = await api.draftWorkspaceLoad(request.assetId!);
        let loaded: DraftWorkingDocument;
        if (saved) loaded = await openDraftDocument(saved);
        else {
          const [asset] = await api.getAssetsByIds([request.assetId!]);
          if (!asset?.store_path) throw new Error("素材文件不可用，请重新选择图片");
          const url = await api.readImageDataUrl(asset.store_path);
          const image = await decodeLayerImage(url);
          loaded = newDraftDocument(image.naturalWidth, image.naturalHeight, true);
          loaded.layers = [await importedDraftLayer(url, asset.name, { ...loaded, layers: [] })];
        }
        if (cancelled) return;
        working.current = loaded; setSelectedId(loaded.layers[loaded.layers.length - 1]?.id ?? ""); refresh();
      } catch (e) { if (!cancelled) fail(e, "草稿读取失败，请关闭后重试"); }
      finally { if (!cancelled) setLoading(false); }
    })();
    void api.layerFonts().then(names => { if (!cancelled && names.length) setFonts(names); }).catch(() => {});
    return () => {
      cancelled = true; mounted.current = false;
      if (frame.current) cancelAnimationFrame(frame.current);
      // StrictMode replays effects: a cancelled frame must not block the next repaint.
      frame.current = 0; damage.current = undefined;
    };
  }, [request]);

  useEffect(() => {
    const node = preview.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect; setViewportSize({ width, height });
    });
    observer.observe(node); return () => observer.disconnect();
  }, [loading, !!doc]);
  useEffect(() => { repaint(); }, [!!doc, loading, epoch]);

  useEffect(() => { if (editingText) inlineText.current?.focus({ preventScroll: true }); }, [editingText]);
  useEffect(() => { if (closeConfirm) closeDialog.current?.querySelectorAll<HTMLButtonElement>("button")[1]?.focus(); }, [closeConfirm]);

  function finishText() {
    const before = textBefore.current;
    textBefore.current = null;
    if (before && working.current && before !== working.current) record(before, working.current);
    setEditingText("");
  }
  function startText(layer: DraftSurface) {
    if (layer.kind !== "text" || layer.locked) return;
    finishText(); setSelectedId(layer.id); textBefore.current = working.current; setEditingText(layer.id);
  }
  function patchText(values: Partial<LayerText>) {
    const current = working.current?.layers.find(l => l.id === selectedId);
    if (!current?.text || current.locked) return;
    patchLayer(current.id, { text: { ...current.text, ...values } }, false);
  }
  function beginProperty() { cancelGesture(); if (!propertyBefore.current) propertyBefore.current = working.current; }
  function finishProperty() {
    const before = propertyBefore.current; propertyBefore.current = null;
    if (before && working.current && before !== working.current) record(before, working.current);
  }
  function chooseTool(next: Tool) {
    cancelGesture(); finishText(); finishProperty(); setTool(next); setRubber(null); setCursor(null);
    const current = working.current;
    if (next === "crop" && current) {
      const rect = fitDraftCropRatio({ x: 0, y: 0, width: current.width, height: current.height }, cropAspect());
      setSelection(null); setCropRect(rect); frameCrop(rect); viewport.reset();
    } else { setCropRect(null); setCropViewBounds(null); }
  }

  function localPoint(layer: DraftSurface, p: Point): Point {
    return { x: (p.x - layer.x) * layer.canvas.width / layer.width, y: (p.y - layer.y) * layer.canvas.height / layer.height };
  }
  function point(event: { clientX: number; clientY: number }): Point {
    const box = stage.current!.getBoundingClientRect(), current = working.current!;
    return { x: (event.clientX - box.left) * current.width / box.width, y: (event.clientY - box.top) * current.height / box.height };
  }
  function brushPoint(event: PointerEvent, layer: DraftSurface): BrushPoint {
    return { ...localPoint(layer, point(event)), pressure: event.pointerType === "pen" ? event.pressure : 1, time: event.timeStamp };
  }
  function strokeDamage(g: Gesture) {
    const rect = g.stroke?.takeDirtyBounds();
    if (!rect || !g.layer) return;
    const layer = g.layer;
    repaint({ x: layer.x + rect.x * layer.width / layer.canvas.width, y: layer.y + rect.y * layer.height / layer.canvas.height,
      width: rect.width * layer.width / layer.canvas.width, height: rect.height * layer.height / layer.canvas.height });
  }
  function pickColor(p: Point) {
    if (!composite.current || !working.current) return;
    paintDraft(composite.current, working.current);
    if (p.x < 0 || p.y < 0 || p.x >= working.current.width || p.y >= working.current.height) return;
    const pixel = composite.current.getContext("2d")!.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    if (pixel[3]) setColor(`#${[pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, "0")).join("")}`);
  }
  function paintable(): DraftSurface | null {
    const layer = working.current?.layers.find(l => l.id === selectedId);
    if (!layer || layer.kind !== "raster" || layer.locked || !layer.visible) {
      setError("请先选择可见且未锁定的绘画图层，或点击新建绘画层"); return null;
    }
    return layer;
  }
  function onDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busyRef.current || library.importing || loading || !working.current || gesture.current || event.button !== 0 || typing(event.target)
      || (event.target as Element).closest(".draft-view-tools")) return;
    event.preventDefault(); event.stopPropagation(); preview.current?.focus({ preventScroll: true });
    finishText(); finishProperty(); setError("");
    const p = point(event), current = working.current;
    cursorPosition.current = p; setCursor(p); setAltHeld(event.altKey);
    if (tool === "crop" && cropRect) {
      const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-draft-crop-handle]")?.dataset.draftCropHandle as DraftCropHandle | undefined;
      if (!handle && (p.x < cropRect.x || p.y < cropRect.y || p.x > cropRect.x + cropRect.width || p.y > cropRect.y + cropRect.height)) return;
      gesture.current = { id: event.pointerId, start: p, last: p, before: current, kind: "crop", cropRect, cropHandle: handle ?? "move" };
      event.currentTarget.setPointerCapture(event.pointerId); return;
    }
    if (event.altKey || tool === "eyedropper") { pickColor(p); return; }
    if (tool === "text") {
      const hit = draftHit(current, p.x, p.y);
      if (hit?.kind === "text") { startText(hit); return; }
      try {
        const width = Math.min(480, current.width), height = Math.min(200, current.height);
        const layer: DraftSurface = { ...rasterLayer(width, height, "文字"), kind: "text", x: clamp(p.x, 0, current.width - 1), y: clamp(p.y, 0, current.height - 1),
          text: { content: "", fontFamily: fonts[0], fontSize: 48, color: foreground.current, bold: false, align: "left", lineHeight: 1.25, letterSpacing: 0, boxWidth: width, boxHeight: height } };
        addLayer(layer); startText(layer);
      } catch (e) { fail(e); }
      return;
    }
    let layer: DraftSurface | undefined;
    let kind: Gesture["kind"] = tool === "eraser" ? "brush" : tool as Gesture["kind"];
    if (tool === "move") {
      const resize = (event.target as HTMLElement).dataset.draftResize !== undefined;
      layer = resize ? current.layers.find(l => l.id === selectedId) : draftHit(current, p.x, p.y);
      setSelectedId(layer?.id ?? "");
      if (!layer || layer.locked) return;
      if (resize) kind = "resize";
    } else if (["brush", "eraser", "rect", "ellipse", "arrow"].includes(tool)) {
      layer = paintable() ?? undefined; if (!layer) return;
    }
    const g: Gesture = { id: event.pointerId, start: p, last: p, before: current, layer, kind };
    if (kind === "select" || kind === "lasso") { g.selectionMode = selectionMode; g.selectionBefore = selection; }
    if (kind === "lasso") { g.lassoPoints = [p]; setLassoPreview([p]); }
    if (kind === "brush" && layer) {
      g.stroke = new DraftBrushStroke(layer.canvas, { color: foreground.current, size: size * layer.canvas.width / layer.width,
        hardness, opacity, flow: 1, smoothing, pressure, inertia, erase: tool === "eraser", selection: draftLayerSelection(layer, selection) }, brushPoint(event.nativeEvent, layer));
      strokeDamage(g);
    }
    gesture.current = g;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onMove(event: ReactPointerEvent<HTMLDivElement>) {
    viewport.onPointerMove(event);
    if (!working.current || !stage.current || event.isPropagationStopped()) return;
    const p = point(event);
    cursorPosition.current = p; setAltHeld(event.altKey);
    if ((event.target as Element).closest(".draft-view-tools,button,textarea")) {
      setCursor(null);
      if (!gesture.current) return;
    }
    cursorCircle.current?.setAttribute("cx", String(p.x)); cursorCircle.current?.setAttribute("cy", String(p.y));
    if (!gesture.current) { setCursor(library.open ? null : p); return; }
    const g = gesture.current;
    if (event.pointerId !== g.id) return;
    g.last = p;
    if (g.kind === "lasso") {
      const samples = event.nativeEvent.getCoalescedEvents?.();
      let points = g.lassoPoints ?? [g.start];
      for (const sample of samples?.length ? samples : [event.nativeEvent]) points = appendDraftLassoPoint(points, point(sample));
      g.lassoPoints = points; setLassoPreview(points);
    } else if (g.kind === "crop" && g.cropRect && g.cropHandle) {
      setCropRect(resizeDraftCrop(g.cropRect, g.cropHandle, p.x - g.start.x, p.y - g.start.y, cropAspect()));
    } else if (g.stroke && g.layer) {
      const samples = event.nativeEvent.getCoalescedEvents?.();
      g.stroke.append((samples?.length ? samples : [event.nativeEvent]).map(sample => brushPoint(sample, g.layer!)));
      strokeDamage(g);
    } else if ((g.kind === "move" || g.kind === "resize") && g.layer) {
      const layer = g.layer;
      let values: Partial<DraftSurface>;
      if (g.kind === "resize") {
        const factor = clamp(Math.max((p.x - layer.x) / layer.width, (p.y - layer.y) / layer.height),
          Math.max(1 / layer.width, 1 / layer.height), Math.min(4096 / layer.width, 4096 / layer.height));
        values = { width: layer.width * factor, height: layer.height * factor };
      } else values = { x: clamp(layer.x + p.x - g.start.x, -100000, 100000), y: clamp(layer.y + p.y - g.start.y, -100000, 100000) };
      patchLayer(layer.id, values, false);
    } else {
      let b = p;
      if (event.shiftKey && (g.kind === "rect" || g.kind === "ellipse")) {
        const side = Math.min(Math.abs(p.x - g.start.x), Math.abs(p.y - g.start.y));
        b = { x: g.start.x + Math.sign(p.x - g.start.x) * side, y: g.start.y + Math.sign(p.y - g.start.y) * side }; g.last = b;
      }
      setRubber({ kind: g.kind, a: g.start, b });
    }
  }
  function recordPixels(layer: DraftSurface, patches: PixelPatch[]) {
    if (!patches.length) return;
    history.current.push({ bytes: patches.reduce((n, p) => n + p.before.byteLength + p.after.byteLength, 0),
      undo: () => applyPixelPatches(layer.canvas, patches, "before"), redo: () => applyPixelPatches(layer.canvas, patches, "after") });
    refresh(undefined, true);
  }
  function editPixels(layer: DraftSurface, region: DraftRect | null, edit: (context: CanvasRenderingContext2D) => void) {
    const canvas = layer.canvas, ctx = canvas.getContext("2d")!;
    const x = clamp(Math.floor(region?.x ?? 0), 0, canvas.width), y = clamp(Math.floor(region?.y ?? 0), 0, canvas.height);
    const right = clamp(Math.ceil(region ? region.x + region.width : canvas.width), 0, canvas.width);
    const bottom = clamp(Math.ceil(region ? region.y + region.height : canvas.height), 0, canvas.height);
    if (right <= x || bottom <= y) return;
    const width = right - x, height = bottom - y, before = ctx.getImageData(x, y, width, height).data;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    clipDraftSelection(ctx, draftLayerSelection(layer, selection)); edit(ctx); ctx.restore();
    recordPixels(layer, [{ x, y, width, height, before, after: ctx.getImageData(x, y, width, height).data }]);
  }
  function drawShape(g: Gesture) {
    if (!g.layer) return;
    const layer = g.layer, a = localPoint(layer, g.start), b = localPoint(layer, g.last);
    const width = size * layer.canvas.width / layer.width;
    const margin = Math.max(width * 5, 12 + width);
    const region = { x: Math.min(a.x, b.x) - margin, y: Math.min(a.y, b.y) - margin,
      width: Math.abs(b.x - a.x) + margin * 2, height: Math.abs(b.y - a.y) + margin * 2 };
    editPixels(layer, region, ctx => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.globalAlpha = opacity;
      ctx.beginPath();
      if (g.kind === "rect") ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      else if (g.kind === "ellipse") ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.max(width * 4, 12);
        ctx.moveTo(b.x + Math.cos(angle - Math.PI * .8) * length, b.y + Math.sin(angle - Math.PI * .8) * length);
        ctx.lineTo(b.x, b.y); ctx.lineTo(b.x + Math.cos(angle + Math.PI * .8) * length, b.y + Math.sin(angle + Math.PI * .8) * length);
      }
      ctx.stroke();
    });
  }
  function onUp(event: ReactPointerEvent<HTMLDivElement>) {
    viewport.endPan();
    if (working.current && stage.current) {
      const p = point(event); cursorPosition.current = p;
      const bounds = preview.current?.getBoundingClientRect();
      setCursor(bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom ? p : null);
    }
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    if (g.stroke && g.layer) recordPixels(g.layer, g.stroke.finish(brushPoint(event.nativeEvent, g.layer)));
    else if (g.kind === "move" || g.kind === "resize") {
      if (working.current && g.before !== working.current) record(g.before, working.current);
    } else if (g.kind === "crop") {
      if (cropRect) frameCrop(cropRect);
    } else if (g.kind === "lasso" || g.kind === "select") {
      const next = g.kind === "lasso" ? createDraftLasso(appendDraftLassoPoint(g.lassoPoints ?? [g.start], point(event), 0))
        : draftSelection(g.start, point(event), g.before);
      try { setSelection(combineDraftSelection(g.selectionBefore ?? null, next, g.selectionMode ?? "replace", { x: 0, y: 0, width: g.before.width, height: g.before.height })); }
      catch (e) { fail(e); }
    } else if (Math.hypot(g.last.x - g.start.x, g.last.y - g.start.y) > .5) drawShape(g);
    setRubber(null); setLassoPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function cancelGesture() {
    const g = gesture.current; gesture.current = null;
    if (g?.kind === "crop" && g.cropRect) setCropRect(g.cropRect);
    else if (g) { g.stroke?.cancel(); refresh(g.before); }
    setRubber(null); setLassoPreview(null); viewport.endPan();
    if (g && preview.current?.hasPointerCapture(g.id)) preview.current.releasePointerCapture(g.id);
  }
  useEffect(() => {
    const blur = () => { cancelGesture(); setCursor(null); setAltHeld(false); };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  function undo(redo = false) {
    if (busyRef.current || library.importing) return;
    if (gesture.current) { cancelGesture(); return; }
    finishText(); finishProperty();
    if (tool === "crop") { setCropRect(null); setCropViewBounds(null); setTool("move"); }
    if (redo ? history.current.redo() : history.current.undo()) { setSelection(null); refresh(undefined, true); }
  }
  function fillOrClear(clear: boolean) {
    if (busyRef.current) return;
    cancelGesture();
    finishText(); const layer = paintable(); if (!layer) return;
    editPixels(layer, draftLayerSelection(layer, selection), ctx => {
      if (clear) ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      else { ctx.globalAlpha = opacity; ctx.fillStyle = foreground.current; ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height); }
    });
  }
  function invertSelection() {
    const current = working.current;
    if (!current || !selection || interactionBusy || loading || closeConfirm) return;
    cancelGesture();
    try { setSelection(invertDraftSelection(selection, { x: 0, y: 0, width: current.width, height: current.height })); }
    catch (e) { fail(e); }
  }
  function removeLayer() {
    cancelGesture();
    const current = working.current, layer = current?.layers.find(l => l.id === selectedId);
    if (!current || !layer || layer.locked) return;
    finishText();
    commit({ ...current, layers: current.layers.filter(l => l.id !== layer.id) }, layer.canvas.width * layer.canvas.height * 4);
    setSelectedId(current.layers.find(l => l.id !== layer.id)?.id ?? "");
  }
  function reorder(direction: number) {
    cancelGesture();
    const current = working.current; if (!current) return;
    const index = current.layers.findIndex(l => l.id === selectedId), next = index + direction;
    if (index < 0 || next < 0 || next >= current.layers.length || current.layers[index].locked) return;
    const layers = [...current.layers]; [layers[index], layers[next]] = [layers[next], layers[index]]; commit({ ...current, layers });
  }
  async function importFiles(files: File[]) {
    if (!working.current || busyRef.current || !files.length) return;
    finishText(); finishProperty(); cancelGesture(); busyRef.current = true; setBusy(true); setError("");
    try {
      const before = working.current; let next = before;
      for (const file of files) {
        if (!file.type.startsWith("image/") || file.size > 30 * 1024 * 1024) throw new Error("请选择 30 MB 以内的图片");
        const url = URL.createObjectURL(file);
        try { const layer = await importedDraftLayer(url, file.name.replace(/\.[^.]+$/, ""), next); next = { ...next, layers: [...next.layers, layer] }; }
        finally { URL.revokeObjectURL(url); }
      }
      if (!mounted.current) return;
      const bytes = next.layers.slice(before.layers.length).reduce((n, l) => n + l.canvas.width * l.canvas.height * 4, 0);
      record(before, next, bytes); setSelectedId(next.layers[next.layers.length - 1].id);
      setSelection(null); chooseTool("move"); preview.current?.focus({ preventScroll: true });
    } catch (e) { if (mounted.current) fail(e, "导入图片失败，请重试"); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function requestClose() {
    if (busyRef.current || library.importing) return;
    cancelGesture(); finishText(); finishProperty();
    if (revision.current !== savedRevision.current || pendingCrop) setCloseConfirm(true); else close();
  }
  async function save() {
    if (!working.current || busyRef.current || library.importing) return;
    cancelGesture(); finishText(); finishProperty();
    if (cropRect && !applyCrop()) return;
    const current = working.current;
    if (!dirty && !request.assetId && revision.current === 0) { close(); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const document = serializeDraft(current), dataUrl = draftPng(current);
      const attempt = saveAttempt.current?.revision === revision.current ? saveAttempt.current : { revision: revision.current, id: crypto.randomUUID() };
      saveAttempt.current = attempt;
      if (request.saveToCanvas) await request.saveToCanvas(document, dataUrl, attempt.id);
      else await api.saveDraftWorkspace({ document, dataUrl, projectId: request.projectId, saveId: attempt.id });
      savedRevision.current = attempt.revision;
      notifySuccess(request.saveToCanvas ? "草稿工程已保存到画板和素材库" : "草稿工程已保存到素材库"); close();
    } catch (e) { if (mounted.current) fail(e, "草稿保存失败，请重试"); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function exportPsd() {
    if (!working.current || busyRef.current || library.importing) return;
    finishText(); cancelGesture();
    if (cropRect && !applyCrop()) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const path = await saveFileDialog({ title: "导出草稿 PSD", defaultPath: "草稿.psd", filters: [{ name: "Photoshop", extensions: ["psd"] }] });
      if (!path) return;
      const current = working.current;
      const names = await api.layerExportFontNames(current.layers.flatMap(l => l.text ? [l.text.fontFamily] : []));
      const bytes = await exportLayerPsd(draftAsLayerDocument(current), names);
      await api.layerExportPsd(path, exportBytesBase64(bytes)); notifySuccess("PSD 已导出");
    } catch (e) { fail(e, "导出 PSD 失败，请重试"); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (closeConfirm && event.key === "Tab") {
        const buttons = Array.from(closeDialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (library.handleKeyDown(event)) {
        if (event.key === "Tab" && !typing(event.target)) { cancelGesture(); finishText(); finishProperty(); }
        return;
      }
      if (event.target instanceof Element && event.target.closest("[data-draft-color-panel]")
        && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")) return;
      if (event.key === "Alt") setAltHeld(true);
      if (event.isComposing) return;
      if (event.code === "Space") return; // useLayerViewport owns the temporary Hand.
      const input = typing(event.target), command = event.ctrlKey || event.metaKey;
      let handled = true;
      if (event.key === "Escape") {
        if (busyRef.current) { /* Keep the in-flight save and panel. */ }
        else if (closeConfirm) setCloseConfirm(false);
        else if (gesture.current) cancelGesture();
        else if (editingText) finishText();
        else if (tool === "crop") chooseTool("move");
        else if (selection) setSelection(null);
        else requestClose();
      } else if (closeConfirm || busyRef.current || loading) handled = false;
      else if (command && event.key.toLowerCase() === "s") void save();
      else if (input) handled = false;
      else if (command && event.key.toLowerCase() === "z") undo(event.shiftKey);
      else if (command && event.key.toLowerCase() === "y") undo(true);
      else if (command && event.key.toLowerCase() === "d") { cancelGesture(); setSelection(null); }
      else if (command && event.key.toLowerCase() === "a" && working.current) { cancelGesture(); setSelection({ x: 0, y: 0, width: working.current.width, height: working.current.height }); }
      else if (command && event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") { if (!event.repeat) invertSelection(); }
      else if (event.key === "Enter" && tool === "crop") applyCrop();
      else if (event.key === "Delete" || event.key === "Backspace") { if (selection) fillOrClear(true); else removeLayer(); }
      else if (!command && !event.altKey && event.key === "[") setSize(v => stepDraftBrushSize(v, -1));
      else if (!command && !event.altKey && event.key === "]") setSize(v => stepDraftBrushSize(v, 1));
      else if (!command && !event.altKey) {
        const entry = TOOLS.find(t => t[2] && t[2].toLowerCase() === event.key.toLowerCase());
        if (entry) chooseTool(entry[0]); else handled = false;
      } else handled = false;
      if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Alt") setAltHeld(false); };
    window.addEventListener("keydown", key, true); window.addEventListener("keyup", keyUp, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", keyUp, true); };
  });

  const property = (name: string, value: number, min: number, max: number, onChange: (value: number) => void, step = 1) => <label>{name}<input aria-label={name} type="number" value={Math.round(value * 100) / 100} min={min} max={max} step={step}
    onFocus={beginProperty} onBlur={finishProperty} onChange={event => { beginProperty(); const v = event.currentTarget.valueAsNumber; if (Number.isFinite(v)) onChange(clamp(v, min, max)); }} /></label>;
  const brushCursor = !!cursor && ["brush", "eraser"].includes(tool) && !viewport.spaceHeld && !viewport.panning && !altHeld && !interactionBusy && !library.open && !closeConfirm;
  const cropOffset = tool === "crop" && cropViewBounds && doc ? {
    x: (doc.width / 2 - cropViewBounds.x - cropViewBounds.width / 2) * effectiveScale,
    y: (doc.height / 2 - cropViewBounds.y - cropViewBounds.height / 2) * effectiveScale,
  } : { x: 0, y: 0 };
  const selectedBounds = selected && tool === "move" && selected.visible;
  const rubberRect = rubber && doc ? draftSelection(rubber.a, rubber.b, doc) : null;
  return <ModalShell title="草稿编辑器" className="draft-editor" width="lg" preventClose showCloseButton={false} onClose={requestClose}
    panelProps={{ onKeyDown: event => { if (event.key !== "Tab") event.stopPropagation(); }, onKeyUp: event => event.stopPropagation(), onPaste: event => {
      if (typing(event.target) || library.open || interactionBusy) return; const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void importFiles(files); }
    } }} headerActions={<>
      <button className="draft-action" aria-label="素材库" title="素材库 · Tab" aria-expanded={library.open} disabled={!doc || interactionBusy || loading || closeConfirm} onClick={() => { cancelGesture(); finishText(); finishProperty(); library.toggle(); }}><ImagePlus size={15} />素材库 <kbd>Tab</kbd></button>
      <span className="draft-save-state">{dirty ? "有未保存的修改" : doc ? "本地草稿" : ""}</span>
      <button className="draft-action" disabled={!doc || interactionBusy} onClick={() => void exportPsd()}>导出 PSD</button>
      <button className="draft-primary" disabled={!doc || interactionBusy || loading || (!dirty && !request.assetId)} onClick={() => void save()}><Save size={15} />{interactionBusy ? "正在处理…" : request.saveToCanvas ? "保存到画板" : "保存工程"}</button>
      <button className="draft-icon" aria-label="关闭草稿" title="关闭草稿" disabled={interactionBusy} onClick={requestClose}><X size={18} /></button>
    </>}>
    {error && <div role="alert" className="draft-error">{userErrorMessage(error, "草稿操作失败，请重试")}<button aria-label="收起提示" onClick={() => setError("")}><X size={14} /></button></div>}
    {loading ? <div className="draft-empty" role="status">正在读取草稿…</div> : !doc ? <div className="draft-empty"><p>草稿未能打开。关闭后重新选择图片。</p></div> : <>
      <div className="draft-options"><div className="draft-history"><button title="撤销 · ⌘/Ctrl Z" aria-label="撤销" disabled={interactionBusy || !history.current.canUndo} onClick={() => undo()}><Undo2 size={17} /></button><button title="重做 · ⌘/Ctrl Shift Z" aria-label="重做" disabled={interactionBusy || !history.current.canRedo} onClick={() => undo(true)}><Redo2 size={17} /></button></div>
        {tool === "crop" && cropRect ? <>
          <label>比例<select aria-label="裁剪比例" value={cropRatio} disabled={interactionBusy} onChange={e => changeCropRatio(e.target.value)}>
            <option value="free">自由</option><option value="original">原始比例</option>{["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"].map(ratio => <option key={ratio}>{ratio}</option>)}
          </select></label>
          <label>宽<input aria-label="裁剪宽度" type="number" min="1" max="4096" value={cropRect.width} disabled={interactionBusy} onChange={e => changeCropSize("width", e.currentTarget.valueAsNumber)} />px</label>
          <label>高<input aria-label="裁剪高度" type="number" min="1" max="4096" value={cropRect.height} disabled={interactionBusy} onChange={e => changeCropSize("height", e.currentTarget.valueAsNumber)} />px</label>
          <button className="draft-primary" disabled={interactionBusy} onClick={applyCrop}><Check size={14} />应用裁剪</button>
          <button className="draft-action" disabled={interactionBusy} onClick={() => chooseTool("move")}>取消裁剪</button>
        </> : <>
        {(tool === "select" || tool === "lasso") && <><div className="draft-selection-modes" role="group" aria-label="选区模式">
          {([["replace", "新选区"], ["add", "增选"], ["subtract", "减选"]] as const).map(([mode, label]) => <button key={mode} aria-pressed={selectionMode === mode} disabled={interactionBusy} onClick={() => { cancelGesture(); setSelectionMode(mode); }}>{label}</button>)}
        </div><button className="draft-action" disabled={interactionBusy || closeConfirm || !selection} title="反选 · ⌘/Ctrl Shift I" onClick={invertSelection}>反选</button></>}
        {selection && <button className="draft-action" disabled={interactionBusy} title="取消选区 · ⌘/Ctrl D" onClick={() => { cancelGesture(); setSelection(null); }}>取消选区</button>}
        <label className="draft-color">颜色<input aria-label="前景颜色" type="color" value={color} onChange={e => setColor(e.target.value)} disabled={interactionBusy} /></label>
        <label>大小<DraftBrushSizeInput key={tool === "eraser" ? "eraser" : "brush"} aria-label={`${tool === "eraser" ? "橡皮" : "画笔"}大小`} value={size} onChange={setSize} disabled={interactionBusy} />px</label>
        <label>硬度<input aria-label={`${tool === "eraser" ? "橡皮" : "画笔"}硬度`} type="range" min="0" max="100" value={hardness * 100} disabled={interactionBusy} onChange={e => setHardness(Number(e.target.value) / 100)} /></label>
        <label>不透明度<input aria-label={`${tool === "eraser" ? "橡皮" : "画笔"}不透明度`} type="number" min="1" max="100" value={Math.round(opacity * 100)} disabled={interactionBusy} onChange={e => setOpacity(clamp(Number(e.target.value), 1, 100) / 100)} />%</label>
        <label>平滑<input aria-label={`${tool === "eraser" ? "橡皮" : "画笔"}平滑`} type="range" min="0" max="80" value={smoothing * 100} disabled={interactionBusy} onChange={e => setSmoothing(Number(e.target.value) / 100)} /></label>
        {["brush", "eraser"].includes(tool) && <><label className="draft-pressure" title="数位笔力度控制笔径，鼠标保持设定大小"><input type="checkbox" aria-label="压感" checked={pressure} disabled={interactionBusy} onChange={e => setPressure(e.target.checked)} />压感</label>
          <label title="拖动时笔迹延后跟随，强度越大越稳定；松笔补齐到末端">惯性<input aria-label={`${tool === "eraser" ? "橡皮" : "画笔"}惯性`} type="range" min="0" max="100" value={inertia * 100} disabled={interactionBusy} onChange={e => setInertia(Number(e.target.value) / 100)} /><output>{Math.round(inertia * 100)}%</output></label></>}
        </>}
        <button className="draft-icon draft-layers-toggle" aria-label="切换图层面板" aria-pressed={showLayers} onClick={() => setShowLayers(v => !v)}><Layers size={18} /></button>
      </div>
      <div className={`draft-layout${showLayers ? "" : " is-layers-hidden"}`}>
        <div className="draft-tools" role="toolbar" aria-label="草稿工具">{TOOLS.map(([id, label, key, Icon]) => <button key={id} aria-label={label} aria-pressed={tool === id} title={`${label}${key ? ` · ${key}` : ""}`} disabled={interactionBusy} onClick={() => chooseTool(id)}><Icon size={19} /></button>)}<div className="draft-tools-rule" /><button aria-label="导入图片" title="导入图片，也可粘贴或拖入" disabled={interactionBusy} onClick={() => fileInput.current?.click()}><ImagePlus size={20} /></button></div>
        <div ref={preview} tabIndex={0} aria-label="草稿画布" className={`draft-preview${brushCursor ? " is-brush-cursor" : ""}${tool === "crop" ? " is-cropping" : ""}${viewport.spaceHeld ? " is-pan-ready" : ""}${viewport.panning ? " is-panning" : ""}`}
          onPointerDownCapture={event => { if (!interactionBusy && !gesture.current) viewport.onPointerDownCapture(event); }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }} onPointerLeave={() => setCursor(null)}
          onDoubleClick={event => { if (viewport.blocksDoubleClick() || interactionBusy || (event.target as Element).closest("button")) return; if (tool === "crop") { applyCrop(); return; } const layer = draftHit(doc, point(event).x, point(event).y); if (layer?.kind === "text") startText(layer); }}
          onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => { if (library.handleDrop(event)) return; event.preventDefault(); event.stopPropagation(); if (interactionBusy) return; void importFiles(Array.from(event.dataTransfer.files)); }}>
          <div className="draft-stage" ref={stage} style={{ width: doc.width * fit, height: doc.height * fit, transform: `translate(${viewport.view.x + cropOffset.x}px, ${viewport.view.y + cropOffset.y}px) scale(${viewport.view.zoom})` }}>
            <canvas data-draft-canvas ref={composite} width={doc.width} height={doc.height} />
            {tool === "crop" && cropRect && <DraftCropPreview doc={doc} rect={cropRect} fit={fit} scale={effectiveScale} epoch={epoch} />}
            <svg className="draft-overlay" viewBox={`0 0 ${doc.width} ${doc.height}`}>
              {selection && (!lassoPreview || selectionMode !== "replace") && <SelectionOutline path={selectionPath} zoom={viewport.view.zoom} />}
              {lassoPreview && <SelectionOutline preview lasso path={lassoPreview.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")} zoom={viewport.view.zoom} />}
              {rubber && rubber.kind === "arrow" ? <line x1={rubber.a.x} y1={rubber.a.y} x2={rubber.b.x} y2={rubber.b.y} stroke={color} strokeWidth={size} /> : rubberRect && (rubber?.kind === "select" ? <SelectionOutline preview path={draftSelectionSvgPath(rubberRect)} zoom={viewport.view.zoom} /> : rubber?.kind === "ellipse" ? <ellipse cx={rubberRect.x + rubberRect.width / 2} cy={rubberRect.y + rubberRect.height / 2} rx={rubberRect.width / 2} ry={rubberRect.height / 2} fill="none" stroke={color} strokeWidth={size} /> : <rect {...rubberRect} fill="none" stroke={rubber?.kind === "rect" ? color : "#588af8"} strokeWidth={rubber?.kind === "rect" ? size : 1 / effectiveScale} />)}
              {selectedBounds && <rect data-draft-selected-layer={selected.id} x={selected.x} y={selected.y} width={selected.width} height={selected.height} fill="none" stroke="#588af8" strokeWidth={1.5 / effectiveScale} />}
              {brushCursor && cursor && <circle className="draft-brush-cursor" ref={cursorCircle} cx={cursorPosition.current?.x ?? cursor.x} cy={cursorPosition.current?.y ?? cursor.y} r={size / 2} fill="none" stroke="#777" strokeWidth={1 / effectiveScale} />}
            </svg>
            {tool === "crop" && cropRect && <DraftCropOverlay rect={cropRect} width={doc.width} height={doc.height} fit={fit} zoom={viewport.view.zoom} disabled={interactionBusy}
              onNudge={(handle, dx, dy) => { const next = resizeDraftCrop(cropRect, handle, dx, dy, cropAspect()); setCropRect(next); frameCrop(next); }} />}
            {selectedBounds && !selected.locked && <button data-draft-resize aria-label="等比缩放图层" className="draft-resize" style={{ left: (selected.x + selected.width) * fit, top: (selected.y + selected.height) * fit, transform: `translate(-50%, -50%) scale(${1 / viewport.view.zoom})` }} />}
            {editingText && selected?.id === editingText && selected.text && <textarea ref={inlineText} className="draft-inline-text" aria-label="画布文字" value={selected.text.content} placeholder="输入文字" maxLength={5000}
              style={{ left: selected.x * fit, top: selected.y * fit, width: selected.text.boxWidth, height: selected.text.boxHeight,
                transform: `scale(${selected.width * fit / selected.text.boxWidth}, ${selected.height * fit / selected.text.boxHeight})`, fontFamily: selected.text.fontFamily,
                fontSize: selected.text.fontSize, fontWeight: selected.text.bold ? 700 : 400, lineHeight: selected.text.lineHeight, letterSpacing: selected.text.letterSpacing, textAlign: selected.text.align, color: "transparent", caretColor: selected.text.color }}
              onPointerDown={event => event.stopPropagation()} onChange={e => patchText({ content: e.target.value })} onBlur={finishText} />}
          </div>
          <div className="draft-view-tools layer-view-tools"><button aria-label="缩小视图" onClick={() => viewport.zoomBy(.8)}>−</button><output>{Math.round(effectiveScale * 100)}%</output><button aria-label="放大视图" onClick={() => viewport.zoomBy(1.25)}>+</button><button title="适应窗口" aria-label="适应窗口" onClick={viewport.reset}><Maximize size={14} /></button></div>
        </div>
        {showLayers && <aside className="draft-sidebar" aria-label="图层面板">
          <div className="draft-color-tools">
            <button className="draft-fill-selection" aria-label="填充选区" title="用前景色填充选区" disabled={interactionBusy || closeConfirm || !selection || selection.width <= 0 || selection.height <= 0 || selected?.kind !== "raster" || selected.locked || !selected.visible} onClick={() => fillOrClear(false)}><PaintBucket size={18} /><span>填充</span></button>
            <DraftColorPanel color={color} onChange={setColor} disabled={interactionBusy || closeConfirm} />
          </div>
          <div className="draft-sidebar-title"><strong>图层</strong><span>{doc.layers.length} / 32</span></div>
          <div className="draft-layer-actions"><button aria-label="新建绘画层" title="新建绘画层" disabled={interactionBusy} onClick={() => { try { addLayer(rasterLayer(doc.width, doc.height, `绘画图层 ${doc.layers.length + 1}`)); } catch (e) { fail(e); } }}><Plus size={17} /></button><button aria-label="复制图层" title="复制图层" disabled={interactionBusy || !selected} onClick={() => { cancelGesture(); const source = working.current?.layers.find(layer => layer.id === selectedId); if (source) try { addLayer(duplicateDraftLayer(source)); } catch (e) { fail(e); } }}><Copy size={15} /></button><button aria-label="图层上移" title="图层上移" disabled={interactionBusy || !selected || selected.locked} onClick={() => reorder(1)}><ArrowUp size={16} /></button><button aria-label="图层下移" title="图层下移" disabled={interactionBusy || !selected || selected.locked} onClick={() => reorder(-1)}><ArrowDown size={16} /></button><button aria-label="删除图层" title="删除图层" disabled={interactionBusy || !selected || selected.locked} onClick={removeLayer}><Trash2 size={15} /></button></div>
          <div className="draft-layer-list">{[...doc.layers].reverse().map(layer => <div className={`draft-layer-row${layer.id === selectedId ? " is-selected" : ""}`} key={layer.id} data-draft-layer={layer.id}>
            <button aria-label={`${layer.visible ? "隐藏" : "显示"} ${layer.name}`} disabled={interactionBusy} onClick={() => patchLayer(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
            <button className="draft-layer-select" aria-pressed={layer.id === selectedId} disabled={interactionBusy} onClick={() => { finishText(); setSelectedId(layer.id); }} onDoubleClick={() => startText(layer)}><span className="draft-layer-symbol">{layer.kind === "text" ? <Type size={17} /> : <Square size={16} />}</span><span>{layer.name}</span></button>
            <button aria-label={`${layer.locked ? "解锁" : "锁定"} ${layer.name}`} disabled={interactionBusy} onClick={() => patchLayer(layer.id, { locked: !layer.locked })}>{layer.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
          </div>)}</div>
          {selected && <fieldset className="draft-properties" disabled={interactionBusy || selected.locked}><label>名称<input aria-label="图层名称" maxLength={200} value={selected.name} onFocus={beginProperty} onBlur={finishProperty} onChange={e => { beginProperty(); patchLayer(selected.id, { name: e.target.value }, false); }} /></label>
            <label>图层不透明度<input aria-label="图层不透明度" type="range" min="0" max="100" value={selected.opacity * 100} onPointerDown={beginProperty} onPointerUp={finishProperty} onFocus={beginProperty} onBlur={finishProperty} onChange={e => { beginProperty(); patchLayer(selected.id, { opacity: Number(e.target.value) / 100 }, false); }} /></label>
            <div className="draft-fields">{property("位置 X", selected.x, -100000, 100000, x => patchLayer(selected.id, { x }, false))}{property("位置 Y", selected.y, -100000, 100000, y => patchLayer(selected.id, { y }, false))}
              {property("图层宽度", selected.width, 1, Math.min(4096, 4096 * selected.width / selected.height), width => patchLayer(selected.id, { width, height: selected.height * width / selected.width }, false))}{property("图层高度", selected.height, 1, Math.min(4096, 4096 * selected.height / selected.width), height => patchLayer(selected.id, { height, width: selected.width * height / selected.height }, false))}</div>
            {selected.text && <div className="draft-text-properties"><button className="draft-action" onClick={() => startText(selected)}>编辑画布文字</button>
              <label>字体<select aria-label="文字字体" value={selected.text.fontFamily} onChange={e => patchLayer(selected.id, { text: { ...selected.text!, fontFamily: e.target.value } })}>{Array.from(new Set([selected.text.fontFamily, ...fonts])).map(font => <option key={font}>{font}</option>)}</select></label>
              {property("字号", selected.text.fontSize, 1, 2000, fontSize => patchText({ fontSize }))}
              <label>文字颜色<input type="color" aria-label="文字颜色" value={selected.text.color} onChange={e => patchLayer(selected.id, { text: { ...selected.text!, color: e.target.value } })} /></label>
              <label className="draft-check"><input type="checkbox" checked={selected.text.bold} onChange={e => patchLayer(selected.id, { text: { ...selected.text!, bold: e.target.checked } })} />粗体</label>
              <label>对齐<select aria-label="文字对齐" value={selected.text.align} onChange={e => patchLayer(selected.id, { text: { ...selected.text!, align: e.target.value as LayerText["align"] } })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
            </div>}
          </fieldset>}
        </aside>}
      </div>
      <div className="draft-status"><span>{doc.width} × {doc.height} px</span><span><Hand size={13} />{tool === "crop" ? "拖动边框裁剪或扩展 · Enter 确认 · Esc 取消" : tool === "select" || tool === "lasso" ? `${tool === "lasso" ? "拖动圈出范围 · 松手闭合" : "拖动框选范围"} · Delete 清除像素 · Esc 取消` : "空格拖动 · Alt 取色 · [ ] 调整笔径"}</span><span>撤销占用 {(history.current.bytes / 1024 / 1024).toFixed(1)} MB</span></div>
    </>}
    {library.panel}
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden onChange={e => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    {closeConfirm && <div ref={closeDialog} className="draft-close-confirm" role="alertdialog" aria-modal="true" aria-label="保存草稿修改"><div><h3>保存草稿修改？</h3><p>保存后可再次打开并继续编辑图层。</p><div><button className="draft-action" disabled={interactionBusy} onClick={close}>放弃修改</button><button className="draft-action" disabled={interactionBusy} onClick={() => setCloseConfirm(false)}>继续编辑</button><button className="draft-primary" disabled={interactionBusy} onClick={() => void save()}>保存并退出</button></div></div></div>}
  </ModalShell>;
}
