import { useAnnotationStrokeWheel } from "../lib/useAnnotationStrokeWheel";
import { useAnnotationHistory } from "../lib/useAnnotationHistory";
import { useAnnotationDrawing } from "../lib/useAnnotationDrawing";
import { useAnnotationCanvas } from "../lib/useAnnotationCanvas";
import { useImageZoom } from "../lib/useImageZoom";
import { AnnotationTools } from "./AnnotationTools";
import { TacticalSelect } from "./TacticalSelect";
import "./ImageAnnotator.css";
import { AnnotationTextEditor } from "./AnnotationTextEditor";
import { annotationImageHash, blankAnnotationImage, draftAnnotationBase, loadAnnotationImage, type AnnotationEditImage } from "../lib/annotationDocument";
import { buildBaseCanvas, mapShape, opDims } from "../lib/annotationTransforms";
import { ANNOTATION_COLORS as COLORS, createTextDraft, drawShapes, applyTextEdit, type DrawShape, type TextEdit } from "../lib/annotation";
import { drawLockedCrop, fitCropRatio, resizeLockedCrop, type CropRect } from "../lib/annotationCrop";
import { floatingToolbarPosition } from "../lib/floatingToolbar";
import { useFloatingToolbarSize } from "../lib/useFloatingToolbarSize";
import { isEditableKeyTarget } from "../lib/isEditableKeyTarget";
import { toAnnotationShapes } from "../lib/annotationMetadata";
import { userErrorMessage } from "../lib/userError";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Crop,
  Trash2,
  Redo2,
  Hand,
  Focus,
  FlipHorizontal2,
  FlipVertical2,
  LayoutDashboard,
  RotateCcw,
  RotateCw,
  Save,
  FileCheck2,
  TextCursorInput,
  Undo2,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { invalidateCatalog } from "../lib/useCatalogRevision";
import { beginOnboardingOperation } from "../lib/onboardingStore";
import { notifyError, notifySuccess } from "../lib/notify";
import { chipName } from "./creation/schema";
import type {
  Asset,
  AnnotationMeta,
  AnnotationTransformOp,
  PromptedAsset,
} from "../lib/types";

/**
 * 图片标注面板（全屏遮罩，Lightbox 同级 z-[90]）：共用截图绘制工具 + 裁剪/旋转/镜像。
 * 右键菜单 openAnnotator 唤起，App 最外层挂单实例（store.annotator 驱动）。
 *
 * 底图变换：ops 序列（rotate 90° 步进 / crop 归一化矩形 / flip 镜像）按操作顺序即时生效；每次变换把
 * 已有形状坐标映射到新坐标系（形状锚定图像内容），显示与导出都基于「原图 → ops」的步进
 * 像素变换，导出只输出最终图（裁剪后区域）。
 *
 * 坐标体系：形状存 0-1 相对当前底图坐标；导出换算火山 Seedream 交互编辑的 0-999 归一化
 * 整数（docs.volcengine.com/docs/82379/2582775）——坐标相对最终输出图 = 实际发给模型的
 * 参考图。rect → `<bbox>x1 y1 x2 y2</bbox>`，arrow → 起终点两个 `<point>`。
 *
 * 底图经 Rust 读为 data URL（asset 协议的 convertFileSrc 是跨域源，画进 canvas 会污染
 * 画布、toDataURL 抛 SecurityError）。导出 = 最终底图烧录标注 → 四个出口：
 * 覆盖原文件（同身份、原格式写回并追加本次变换／标注记录）；
 * 添加到画板（保存素材与标注元数据，再创建独立图片卡片）；
 * 保存到素材库（analyses kind=annotation 记坐标）；插入创作板（临时文件 + sidecar 不入库，
 * 「标注」维度随 chip 自动注入，serialize 时展开为 `@图名 的【标注】：<bbox>…`）。
 * 撤销 = 快照栈（形状 + ops 全量快照），画形状/裁剪/旋转/镜像/清空皆可撤销。
 */

type BaseOp = AnnotationTransformOp;
type Tool = DrawShape["type"] | "crop" | "pan";

/** 裁剪框拖拽会话：框内移动 / 手柄缩放 / 框外重新拉框。 */
type CropDrag =
  | { kind: "new"; sx: number; sy: number; prev: CropRect | null }
  | { kind: "move"; sx: number; sy: number; rect: CropRect }
  | { kind: "resize"; handle: string; rect: CropRect };

const CROP_PRESETS: Record<string, number> = { "1:1": 1, "3:4": 3 / 4, "16:9": 16 / 9, "9:16": 9 / 16 };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function ImageAnnotator() {
  const annotator = useStore((s) => s.annotator);
  const closeAnnotator = useStore((s) => s.closeAnnotator);
  const insertAnnotatedToBoard = useStore((s) => s.insertAnnotatedToBoard);
  const assets = useStore((s) => s.assets);
  const activeProjectId = useStore((s) => s.activeProjectId);

  const cachedAsset = annotator ? assets.find((a) => a.id === annotator.assetId) : undefined;
  const [assetResult, setAssetResult] = useState<{
    request: typeof annotator;
    asset: Asset | null;
    error: string | null;
  } | null>(null);
  const resolvedAsset = assetResult?.request === annotator ? assetResult : null;
  const asset = cachedAsset ?? resolvedAsset?.asset;
  const storePath = asset?.store_path ?? null;
  const open = !!annotator;
  const isNewDraft = !!annotator?.saveDraft;
  const [loadedEdit, setLoadedEdit] = useState<{ request: typeof annotator; edit: AnnotationEditImage } | null>(null);
  const edit = loadedEdit?.request === annotator ? loadedEdit?.edit : undefined;
  const isDraft = isNewDraft || edit?.document?.editable.base.kind === "draft";
  const isRevision = !!edit?.revision;
  const assetLoading = !!annotator?.assetId && !cachedAsset && !resolvedAsset;
  const assetError = !cachedAsset ? resolvedAsset?.error : null;

  // assets 只是当前筛选列表；画板图片可能不在其中，不能据此判定素材已删除。
  useEffect(() => {
    setAssetResult(null);
    if (!annotator?.assetId || cachedAsset || annotator.saveDraft) return;
    let cancelled = false;
    api.getAssetsByIds([annotator.assetId])
      .then((found) => {
        if (!cancelled) setAssetResult({
          request: annotator, asset: found.find((item) => item.id === annotator.assetId) ?? null, error: null,
        });
      })
      .catch((error) => {
        if (!cancelled) setAssetResult({
          request: annotator, asset: null, error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => { cancelled = true; };
  }, [annotator, cachedAsset]);

  // 底图 data URL（Rust 读取）+ 预解码元素（导出 drawImage 用）。nat 由预加载解出——
  // 不能依赖渲染中 <img> 的 onLoad：显示区尺寸依赖 nat，nat 又要等 <img> 渲染，互相等会
  // 死锁在「正在加载底图」。预解码元素已 onload，导出画布 drawImage 直接可用（无跨域污染）。
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!open || (!storePath && !isNewDraft)) {
      setImgUrl(null);
      setLoadError(null);
      setNat(null);
      baseImgRef.current = null;
      return;
    }
    let cancelled = false;
    setLoadedEdit(null);
    setImgUrl(null);
    setLoadError(null);
    setNat(null);
    Promise.resolve()
      .then(() => isNewDraft ? { image: blankAnnotationImage() } : loadAnnotationImage(asset!, storePath!))
      .then((loaded: AnnotationEditImage) => {
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          baseImgRef.current = img;
          setLoadedEdit({ request: annotator, edit: loaded });
          setShapes(loaded.document?.editable.shapes ?? []);
          setOps(loaded.document?.meta.transform ?? []);
          if (loaded.document?.editable.base.kind === "draft") {
            setTool("rect");
            setColor("#111111");
          }
          setImgUrl(loaded.image.url);
          setNat({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.onerror = () => {
          if (!cancelled) setLoadError("图片解码失败");
        };
        img.src = loaded.image.url;
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [annotator, storePath, isNewDraft]);

  // 形状 / 底图变换 / 撤销快照栈；换图重置。
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [ops, setOps] = useState<BaseOp[]>([]);
  const history = useAnnotationHistory<{ shapes: DrawShape[]; ops: BaseOp[] }>();
  const drawing = useAnnotationDrawing(shape => { pushUndo(); setShapes(current => [...current, shape]); });
  const { draft } = drawing;
  const [tool, setTool] = useState<Tool>("rect");
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [cropPreset, setCropPreset] = useState("free");
  const [cropDragging, setCropDragging] = useState(false);
  const cropDragRef = useRef<CropDrag | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [textEdit, setTextEdit] = useState<TextEdit<DrawShape["type"]> | null>(null);
  const viewport = useImageZoom(undefined, { min: 1, max: 1 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  useLayoutEffect(() => { viewport.reset(); setSpaceHeld(false); }, [annotator, viewport.reset]);

  function commitText() {
    if (!textEdit || !base) return shapes;
    const next = applyTextEdit(shapes, textEdit, base.w, base.h);
    if (next !== shapes) {
      pushUndo();
      setShapes(next);
    }
    setTextEdit(null);
    return next;
  }


  useEffect(() => {
    setShapes([]);
    setOps([]);
    history.reset();
    drawing.cancel();
    setFilled(false);
    setCropRect(null);
    cropDragRef.current = null;
    setCropPreset("free");
    setCropDragging(false);
    setBusy(false);
    setTextEdit(null);
    if (annotator?.saveDraft) {
      setTool("rect");
      setColor("#111111");
    }
  }, [annotator]);

  // 当前底图 = 原图按序应用 ops（无变换 = 原图本身）。显示用 url/dims，导出用 canvas。
  const [base, setBase] = useState<{ url: string; w: number; h: number } | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!imgUrl || !nat) {
      baseCanvasRef.current = null;
      setBase(null);
      return;
    }
    // 底图坐标系变化（换图 / 裁剪 / 旋转 / 镜像 / 撤销）：旧裁剪框坐标失效，清空。
    cropDragRef.current = null;
    setCropDragging(false);
    setCropRect(null);
    if (ops.length === 0) {
      baseCanvasRef.current = null;
      setBase({ url: imgUrl, w: nat.w, h: nat.h });
      return;
    }
    const img = baseImgRef.current;
    if (!img) return;
    const canvas = buildBaseCanvas(img, ops);
    if (!canvas) {
      setLoadError("底图变换失败");
      return;
    }
    baseCanvasRef.current = canvas;
    // 中间底图统一 PNG（无损，最终导出格式另行决定）。
    setBase({ url: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height });
  }, [imgUrl, nat, ops]);

  // 画布区可用尺寸（ResizeObserver）→ 底图显示尺寸（contain，只缩不放）。
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [open, imgUrl]); // imgUrl 变化后 stage 内容才渲染，需重挂 observer

  const displaySize = useMemo(() => {
    if (!base || !box || box.w <= 0 || box.h <= 0) return null;
    const scale = Math.min(box.w / base.w, box.h / base.h, 1);
    return {
      w: Math.max(1, Math.round(base.w * scale)),
      h: Math.max(1, Math.round(base.h * scale)),
    };
  }, [base, box]);

  const cropToolbarRef = useRef<HTMLDivElement>(null);
  const cropFrameRef = useRef<SVGRectElement>(null);
  const hasCropToolbar = open && tool === "crop" && !!cropRect && !!displaySize && !assetLoading && !assetError && !loadError;
  const cropToolbarSize = useFloatingToolbarSize(cropToolbarRef, hasCropToolbar);
  const [cropToolbarPosition, setCropToolbarPosition] = useState<ReturnType<typeof floatingToolbarPosition>>();
  useLayoutEffect(() => {
    if (!hasCropToolbar || !cropRect || !cropToolbarSize || cropDragging || viewport.dragging) return;
    const stage = stageRef.current;
    const frame = cropFrameRef.current?.getBoundingClientRect();
    if (!stage || !frame) return;
    const bounds = stage.getBoundingClientRect();
    const position = floatingToolbarPosition({
      top: frame.top - bounds.top,
      right: frame.right - bounds.left, bottom: frame.bottom - bounds.top,
    }, cropToolbarSize, { width: bounds.width, height: bounds.height });
    setCropToolbarPosition(previous => previous?.left === position.left && previous.top === position.top ? previous : position);
  }, [hasCropToolbar, cropRect, cropToolbarSize, cropDragging, box, displaySize, viewport.dragging, viewport.style.transform]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftCanvasRef = useRef<HTMLCanvasElement>(null);
  const visibleShapes = useMemo(() => textEdit?.index == null ? shapes : shapes.filter((_, i) => i !== textEdit.index), [shapes, textEdit?.index]);
  const replacesBase = useAnnotationCanvas(canvasRef, draftCanvasRef, baseCanvasRef.current ?? baseImgRef.current,
    base?.w ?? 0, base?.h ?? 0, visibleShapes, draft, open && !!displaySize);

  function chooseTool(next: Tool) { commitText(); drawing.finish(); setTool(next); stageRef.current?.focus({ preventScroll: true }); }

  function isPanGesture(event: React.PointerEvent) {
    return !!base && !busy && !cropDragRef.current && (!draft || !!drawing.polyline.current)
      && (event.button === 1 || (event.button === 0 && (tool === "pan" || spaceHeld)))
      && !(event.target instanceof Element && event.target.closest("button, input, textarea, select, [data-annotation-text-editor]"));
  }

  useEffect(() => {
    if (!open) return;
    const release = (event: KeyboardEvent) => { if (event.code === "Space") setSpaceHeld(false); };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keyup", release); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keyup", release); window.removeEventListener("blur", blur); };
  }, [open]);

  function pushUndo() {
    history.record({ shapes, ops });
  }

  function undo() {
    if (draft) { drawing.cancel(); return; }
    const last = history.undo({ shapes, ops });
    if (!last) return;
    setShapes(last.shapes);
    setOps(last.ops);
  }

  function redo() {
    drawing.cancel();
    const next = history.redo({ shapes, ops });
    if (next) { setShapes(next.shapes); setOps(next.ops); }
  }

  // Esc 关闭 / Ctrl+Z 撤销 / 裁剪模式 Enter 应用、Esc 取消（先于关面板）。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (busy || isEditableKeyTarget(e)) return;
      if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.target instanceof HTMLElement && e.target.closest("button")) return;
        if ((draft && !drawing.polyline.current) || cropDragRef.current) return;
        e.preventDefault(); setSpaceHeld(true); return;
      }
      if (tool === "pan" && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.startsWith("Arrow")) {
        const step = e.shiftKey ? 50 : 10;
        e.preventDefault(); viewport.panBy(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0); return;
      }
      if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("button")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (draft) drawing.cancel();
        else if (tool === "crop") cancelCropMode();
        else closeAnnotator();
      } else if (e.key === "Enter" && tool === "crop" && cropRect) {
        e.preventDefault();
        applyCrop();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault(); redo();
      } else if (e.key === "Enter" && drawing.polyline.current) {
        e.preventDefault(); drawing.finish();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function applyTransform(op: BaseOp) {
    if (!base) return;
    const textShapes = commitText(), line = drawing.pending();
    const current = line ? [...textShapes, line] : textShapes;
    if (line) history.record({ shapes: textShapes, ops });
    history.record({ shapes: current, ops });
    drawing.cancel();
    setOps([...ops, op]);
    setShapes(current.map((s) => mapShape(s, op, base.w, base.h)));
  }

  function rotate(dir: 1 | -1) { applyTransform({ kind: "rotate", dir }); }
  function flip(axis: "horizontal" | "vertical") { applyTransform({ kind: "flip", axis }); }

  function commitCrop(x1: number, y1: number, x2: number, y2: number) {
    if (!base) return;
    const op: BaseOp = {
      kind: "crop",
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    };
    const d = opDims(op, base.w, base.h);
    if (d.w < 16 || d.h < 16) {
      notifyError(null, "裁剪区域过小（宽高需 ≥16 像素）");
      return;
    }
    if (op.x2 - op.x1 > 0.999 && op.y2 - op.y1 > 0.999) {
      // 全图 = 无操作：视为取消，退出裁剪模式（避免「应用无反馈」）。
      setCropRect(null);
      cropDragRef.current = null;
      setCropDragging(false);
      setTool("rect");
      return;
    }
    applyTransform(op);
    setCropRect(null);
    cropDragRef.current = null;
    setCropDragging(false);
    setTool("rect"); // 裁完回画框，继续标注（再裁可重点工具）
  }

  // —— 裁剪模式（持久裁剪框：手柄缩放 / 框内移动 / 框外重画；应用才落 op）——

  function enterCropMode() {
    chooseTool("crop");
    if (!cropRect) {
      const rect = { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 };
      const ratio = normalizedCropRatio(cropPreset);
      setCropRect(ratio && base ? fitCropRatio(rect, ratio, cropMin(base)) : rect);
    }
  }

  function applyCrop() {
    if (!cropRect || cropDragRef.current) return;
    commitCrop(cropRect.x1, cropRect.y1, cropRect.x2, cropRect.y2);
  }

  function cancelCropMode() {
    cropDragRef.current = null;
    setCropDragging(false);
    setCropRect(null);
    setTool("rect");
    stageRef.current?.focus({ preventScroll: true });
  }

  /** 裁剪框最小归一化尺寸（输出像素 ≥16，对齐火山参考图 >14px 约束）。 */
  function cropMin(base: { w: number; h: number }) {
    return { mw: Math.min(0.5, 16 / base.w), mh: Math.min(0.5, 16 / base.h) };
  }

  function normalizedCropRatio(preset: string) {
    if (!base || preset === "free") return null;
    const ratio = preset === "original" ? (nat ? nat.w / nat.h : base.w / base.h) : CROP_PRESETS[preset];
    return ratio ? ratio * base.h / base.w : null;
  }

  function selectCropPreset(preset: string) {
    setCropPreset(preset);
    const ratio = normalizedCropRatio(preset);
    if (base && cropRect && ratio) setCropRect(fitCropRatio(cropRect, ratio, cropMin(base)));
  }

  function onCropHandleDown(e: React.PointerEvent, handle: string) {
    if (e.button !== 0 || !cropRect) return;
    e.preventDefault();
    e.stopPropagation();
    cropDragRef.current = { kind: "resize", handle, rect: { ...cropRect } };
    setCropDragging(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onCropMoveDown(e: React.PointerEvent) {
    if (e.button !== 0 || !cropRect) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toRel(e);
    cropDragRef.current = { kind: "move", sx: p.x, sy: p.y, rect: { ...cropRect } };
    setCropDragging(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function applyCropDrag(p: { x: number; y: number }) {
    const d = cropDragRef.current;
    if (!d) return;
    const ratio = normalizedCropRatio(cropPreset);
    if (d.kind === "new") {
      // 框外重画：实时橡皮筋（显示层做 min/max 归一）。
      setCropRect(ratio ? drawLockedCrop({ x: d.sx, y: d.sy }, p, ratio) : { x1: d.sx, y1: d.sy, x2: p.x, y2: p.y });
      return;
    }
    if (d.kind === "move") {
      const w = d.rect.x2 - d.rect.x1;
      const h = d.rect.y2 - d.rect.y1;
      // 保持抓取点在框内的相对位置；平移不改变大小，钳制在图内。
      const x1 = Math.min(clamp01(p.x - (d.sx - d.rect.x1)), 1 - w);
      const y1 = Math.min(clamp01(p.y - (d.sy - d.rect.y1)), 1 - h);
      setCropRect({ x1, y1, x2: x1 + w, y2: y1 + h });
      return;
    }
    if (!base) return;
    if (ratio) {
      setCropRect(resizeLockedCrop(d.rect, d.handle, p, ratio, cropMin(base)));
      return;
    }
    const { mw, mh } = cropMin(base);
    let { x1, y1, x2, y2 } = d.rect;
    if (d.handle.includes("w")) x1 = Math.min(p.x, x2 - mw);
    if (d.handle.includes("e")) x2 = Math.max(p.x, x1 + mw);
    if (d.handle.includes("n")) y1 = Math.min(p.y, y2 - mh);
    if (d.handle.includes("s")) y2 = Math.max(p.y, y1 + mh);
    setCropRect({
      x1: clamp01(x1),
      y1: clamp01(y1),
      x2: clamp01(x2),
      y2: clamp01(y2),
    });
  }

  function toRel(e: React.PointerEvent): { x: number; y: number } {
    const r = overlayRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !displaySize || tool === "pan") return;
    e.preventDefault();
    const p = toRel(e);
    if (tool === "text") {
      setTextEdit(createTextDraft(p, color, 32 / displaySize.w));
      return;
    }
    if (tool === "crop") {
      // 落点未命中手柄/框内（事件已 stopPropagation）→ 框外重画新裁剪框。
      cropDragRef.current = { kind: "new", sx: p.x, sy: p.y, prev: cropRect ? { ...cropRect } : null };
      setCropDragging(true);
      setCropRect({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    drawing.begin({
      type: tool,
      x1: p.x,
      y1: p.y,
      x2: p.x,
      y2: p.y,
      color,
      strokeRatio: 4 / displaySize.w,
      filled,
    });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = toRel(e);
    if (cropDragRef.current) {
      applyCropDrag(p);
      return;
    }
    if (displaySize) drawing.move(p, displaySize.w, displaySize.h, e.shiftKey);
  }

  function onPointerUp() {
    const d = cropDragRef.current;
    if (d) {
      cropDragRef.current = null;
      setCropDragging(false);
      if (d.kind === "new" && cropRect && base) {
        // 重画太小 → 恢复上一个框（没有则清空）。
        const r = cropRect;
        const { mw, mh } = cropMin(base);
        if (Math.abs(r.x2 - r.x1) < mw || Math.abs(r.y2 - r.y1) < mh) {
          setCropRect(d.prev);
        } else {
          setCropRect({
            x1: Math.min(r.x1, r.x2),
            y1: Math.min(r.y1, r.y2),
            x2: Math.max(r.x1, r.x2),
            y2: Math.max(r.y1, r.y2),
          });
        }
      }
      return;
    }
    if (displaySize) drawing.end(displaySize.w, displaySize.h);
  }

  function cancelCropDrag() {
    const drag = cropDragRef.current;
    if (!drag) return;
    cropDragRef.current = null;
    setCropDragging(false);
    setCropRect(drag.kind === "new" ? drag.prev : drag.rect);
  }

  function clearAll() {
    drawing.cancel();
    if (shapes.length === 0) return;
    pushUndo();
    setShapes([]);
  }

  /** 导出：最终底图（原图 → ops）烧录标注 → dataURL + 火山格式坐标元数据（相对输出图）。 */
  async function buildOutput(preserveDocument = true): Promise<{ dataUrl: string; meta: AnnotationMeta } | null> {
    const img = baseImgRef.current;
    if (!img || (!asset && !isDraft) || !base || !edit) return null;
    const w = base.w;
    const h = base.h;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    const pending = drawing.pending();
    const outputShapes = [...commitText(), ...(pending ? [pending] : [])];
    const jpeg = asset?.ext === "jpg" || asset?.ext === "jpeg";
    const source = baseCanvasRef.current ?? img;
    ctx.drawImage(source, 0, 0, w, h);
    drawShapes(ctx, outputShapes, w, h, canvas, source);
    if (jpeg) {
      // Flatten after erasing so restored transparent pixels also receive white.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    const dataUrl = jpeg
      ? canvas.toDataURL("image/jpeg", 0.92)
      : canvas.toDataURL("image/png");
    const originalMeta = edit.document?.meta;
    const editorBase = edit.document?.editable.base ?? (isNewDraft ? draftAnnotationBase : { kind: "asset" } as const);
    const editable = preserveDocument && (!isRevision || !!edit.document)
      ? { base: editorBase, shapes: outputShapes } : undefined;
    const sourceHash = editable?.base.kind === "asset"
      ? originalMeta?.source_sha256 ?? await annotationImageHash(edit.image) : undefined;
    const meta: AnnotationMeta = {
      schema_version: 1,
      source_asset_id: isDraft ? null : originalMeta?.source_asset_id ?? asset?.id ?? null,
      source_store_path: isDraft ? "" : originalMeta?.source_store_path ?? asset?.store_path ?? "",
      image: { width: w, height: h },
      transform: ops.length > 0 ? ops : undefined,
      source_sha256: sourceHash,
      editable,
      shapes: toAnnotationShapes(outputShapes, w),
    };
    return { dataUrl, meta };
  }

  async function saveToLibrary(overwrite = false) {
    if (busy) return;
    setBusy(true);
    try {
      const out = await buildOutput(!overwrite);
      if (!out) return;
      if (annotator?.saveDraft) {
        await annotator.saveDraft(out.dataUrl, out.meta);
        notifySuccess("草稿已保存到画板和素材库");
        closeAnnotator();
        return;
      }
      const revision = edit?.revision;
      const replacement = revision ?? (overwrite && edit ? { sourceHash: await annotationImageHash(edit.image) } : undefined);
      const saved = await api.saveAnnotatedImage({
        dataUrl: out.dataUrl,
        fileName: replacement ? asset!.name : `${chipName(asset!)}-标注`,
        projectId: replacement ? null : activeProjectId,
        annotationJson: JSON.stringify(out.meta),
        ...(replacement ? { overwrite: { assetId: asset!.id, ...replacement } } : {}),
      });
      if (replacement) {
        useStore.setState(state => ({ assets: state.assets.map(item => item.id === saved.id ? saved : item) }));
        invalidateCatalog();
      }
      notifySuccess(revision ? (isDraft ? "草稿已更新" : "标注图已更新") : overwrite ? "已覆盖原文件" : "标注图已保存到素材库");
      closeAnnotator();
    } catch (e) {
      notifyError(e, "保存标注图失败");
    } finally {
      setBusy(false);
    }
  }

  async function addToCanvas() {
    if (busy || !annotator?.saveToCanvas) return;
    setBusy(true);
    try {
      const out = await buildOutput();
      if (!out) return;
      await annotator.saveToCanvas(out.dataUrl, out.meta, `${chipName(asset!)}-标注`);
      notifySuccess("标注图已添加到画板");
      closeAnnotator();
    } catch (e) {
      notifyError(e, "添加到画板失败");
    } finally {
      setBusy(false);
    }
  }

  async function insertToBoard() {
    if (busy) return;
    const onboardingProjectId = useStore.getState().activeProjectId;
    const completeLesson = beginOnboardingOperation("annotate", onboardingProjectId);
    setBusy(true);
    try {
      const out = await buildOutput(false);
      if (!out) return;
      const temp = await api.saveAnnotationTemp({
        dataUrl: out.dataUrl,
        fileName: `${chipName(asset!)}-标注`,
        // sidecar 随文件落盘：generation_history 反查兜底据此合成，复用提示词不丢本图。
        annotationJson: JSON.stringify(out.meta),
      });
      // 「标注」维度直接挂在注入对象上（不进 DB，无 list_prompted_assets 合成路径）；
      // 仅裁剪/旋转（无标注形状）时不带维度 —— 只是普通参考图。
      // 车牌 anno:{文件名 ulid}：与 generation_history 从临时文件合成的同规则，两条路径同牌。
      const tokens = out.meta.shapes.map((s) => s.token).join("；");
      const prompted: PromptedAsset = {
        ...temp,
        annotation: out.meta,
        ...(tokens
          ? { sections: [{ title: "标注", body: tokens, id: `anno:${temp.id}` }] }
          : {}),
      };
      closeAnnotator();
      insertAnnotatedToBoard(prompted);
      if (tokens && useStore.getState().activeProjectId === onboardingProjectId) completeLesson({ annotationAssetId: temp.id });
      notifySuccess("标注图已插入创作板（未入库）");
    } catch (e) {
      notifyError(e, "插入创作板失败");
    } finally {
      setBusy(false);
    }
  }

  const editStroke = useAnnotationStrokeWheel(shapes, setShapes, pushUndo);
  // Native non-passive input lets the shared object edit consume the wheel only on a hit.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !displaySize) return;
    const onWheel = (event: WheelEvent) => {
      if (busy || draft || textEdit || tool === "crop" || viewport.dragging || spaceHeld) return;
      const bounds = overlay.getBoundingClientRect();
      editStroke(event, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, displaySize.w, displaySize.h);
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, [annotator, editStroke, displaySize, busy, draft, textEdit, tool, viewport.dragging, spaceHeld]);

  if (!annotator) return null;

  const dw = displaySize?.w ?? 0;
  const dh = displaySize?.h ?? 0;
  /** 裁剪模式 UI：框外压暗 + 白边框 + 三分构图线 + 框内移动区（双击应用）+ 8 手柄缩放。 */
  const renderCropUI = (r: CropRect) => {
    const x1 = Math.min(r.x1, r.x2) * dw;
    const y1 = Math.min(r.y1, r.y2) * dh;
    const x2 = Math.max(r.x1, r.x2) * dw;
    const y2 = Math.max(r.y1, r.y2) * dh;
    const w = x2 - x1;
    const h = y2 - y1;
    const dim = "rgba(0,0,0,0.45)";
    const HS = 8; // 手柄边长（显示像素）
    const handles: Array<{ id: string; cx: number; cy: number; cursor: string }> = [
      { id: "nw", cx: x1, cy: y1, cursor: "nwse-resize" },
      { id: "n", cx: x1 + w / 2, cy: y1, cursor: "ns-resize" },
      { id: "ne", cx: x2, cy: y1, cursor: "nesw-resize" },
      { id: "e", cx: x2, cy: y1 + h / 2, cursor: "ew-resize" },
      { id: "se", cx: x2, cy: y2, cursor: "nwse-resize" },
      { id: "s", cx: x1 + w / 2, cy: y2, cursor: "ns-resize" },
      { id: "sw", cx: x1, cy: y2, cursor: "nesw-resize" },
      { id: "w", cx: x1, cy: y1 + h / 2, cursor: "ew-resize" },
    ];
    return (
      <g key="crop-ui">
        {/* 框外压暗（不接事件；框外拖拽走 svg 根 = 重画新框） */}
        <rect x={0} y={0} width={dw} height={y1} fill={dim} pointerEvents="none" />
        <rect x={0} y={y2} width={dw} height={Math.max(0, dh - y2)} fill={dim} pointerEvents="none" />
        <rect x={0} y={y1} width={x1} height={h} fill={dim} pointerEvents="none" />
        <rect x={x2} y={y1} width={Math.max(0, dw - x2)} height={h} fill={dim} pointerEvents="none" />
        {/* 边框 + 三分线（截图软件惯例） */}
        <rect ref={cropFrameRef} x={x1} y={y1} width={w} height={h} fill="none" stroke="#ffffff" strokeWidth={1.5} pointerEvents="none" />
        <line x1={x1 + w / 3} y1={y1} x2={x1 + w / 3} y2={y2} stroke="#ffffff" strokeOpacity={0.3} strokeWidth={1} pointerEvents="none" />
        <line x1={x1 + (2 * w) / 3} y1={y1} x2={x1 + (2 * w) / 3} y2={y2} stroke="#ffffff" strokeOpacity={0.3} strokeWidth={1} pointerEvents="none" />
        <line x1={x1} y1={y1 + h / 3} x2={x2} y2={y1 + h / 3} stroke="#ffffff" strokeOpacity={0.3} strokeWidth={1} pointerEvents="none" />
        <line x1={x1} y1={y1 + (2 * h) / 3} x2={x2} y2={y1 + (2 * h) / 3} stroke="#ffffff" strokeOpacity={0.3} strokeWidth={1} pointerEvents="none" />
        {/* 框内移动区：拖动移动裁剪框，双击应用 */}
        <rect
          x={x1}
          y={y1}
          width={w}
          height={h}
          fill="transparent"
          style={{ cursor: "move" }}
          onPointerDown={onCropMoveDown}
          onDoubleClick={(e) => {
            e.preventDefault();
            applyCrop();
          }}
        />
        {/* 8 缩放手柄 */}
        {handles.map((hd) => (
          <rect
            key={hd.id}
            x={hd.cx - HS / 2}
            y={hd.cy - HS / 2}
            width={HS}
            height={HS}
            fill="#ffffff"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth={1}
            style={{ cursor: hd.cursor }}
            onPointerDown={(e) => onCropHandleDown(e, hd.id)}
          />
        ))}
      </g>
    );
  };

  const toolBtn = (active: boolean) =>
    `annotation-tool ${active ? "is-active " : ""}flex items-center gap-1.5 rounded px-2.5 py-1.5 transition-colors ${
      active ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
    }`;

  const canUndo = history.canUndo;
  const hasDraftInput = !!drawing.pending() || !!textEdit?.shape.textSource?.trim();
  const hasEdits = !!edit && (isRevision
    ? canUndo || hasDraftInput
    : shapes.length > 0 || ops.length > 0 || hasDraftInput);
  const canOverwrite = !!asset?.id && /\.(png|jpe?g|webp|bmp)$/i.test(storePath ?? "");
  const saveLabel = isRevision ? "保存修改" : isDraft ? "保存到画板" : "保存到素材库";

  return createPortal(
    <div
      className="image-annotator fixed inset-0 z-[90] flex flex-col bg-black/90"
      role="dialog"
      onPointerDownCapture={event => {
        if (isPanGesture(event)) return;
        if (!textEdit || (event.target instanceof Element && event.target.closest("[data-annotation-text-editor]"))) return;
        commitText();
        if (event.target instanceof Element && event.target.closest("svg.cursor-crosshair")) event.stopPropagation();
      }}
      aria-modal="true"
      aria-label={isDraft ? "草稿" : "图片标注"}
    >
      {/* 工具条 */}
      <fieldset disabled={busy} className="annotation-toolbar border-b border-white/10 px-3 py-2 text-xs text-white">
        <div className="annotation-toolbar-tools">
        <button type="button" aria-label="移动图片" aria-pressed={tool === "pan"} className={toolBtn(tool === "pan")}
          onClick={() => chooseTool("pan")} title="移动图片：拖动平移，方向键微调；空格或中键临时移动">
          <Hand size={16} aria-hidden="true" />
        </button>
        <AnnotationTools tool={tool} onChange={chooseTool} className={toolBtn} iconSize={16}
          labels={{ rect: "画框", ellipse: "画圆", pencil: "铅笔" }} />
        {(tool === "rect" || tool === "ellipse") && <label className="flex items-center gap-1 whitespace-nowrap">
          <input type="checkbox" checked={filled} onChange={event => setFilled(event.target.checked)} />实心
        </label>}
        <button type="button" aria-label="裁剪" aria-pressed={tool === "crop"} className={toolBtn(tool === "crop")} onClick={enterCropMode} title="裁剪：拖手柄调范围，框内拖动移动，Enter 应用">
          <Crop size={14} /> <span>裁剪</span>
        </button>
        <div className="mx-1 h-4 w-px bg-white/15" />
        <button
          type="button"
          className={toolBtn(false)}
          disabled={!base}
          onClick={() => rotate(-1)}
          title="左转 90°"
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          className={toolBtn(false)}
          disabled={!base}
          onClick={() => rotate(1)}
          title="右转 90°"
        >
          <RotateCw size={14} />
        </button>
        <button
          type="button"
          className={toolBtn(false)}
          disabled={!base}
          onClick={() => flip("horizontal")}
          title="水平镜像：左右翻转图片及标注"
          aria-label="水平镜像"
        >
          <FlipHorizontal2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={toolBtn(false)}
          disabled={!base}
          onClick={() => flip("vertical")}
          title="垂直镜像：上下翻转图片及标注"
          aria-label="垂直镜像"
        >
          <FlipVertical2 size={14} aria-hidden="true" />
        </button>
        <div className="mx-1 h-4 w-px bg-white/15" />
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`颜色 ${c}`}
            onClick={() => setColor(c)}
            className={`flex h-5 w-5 items-center justify-center rounded-full border transition-transform ${
              color === c ? "scale-110 border-white" : "border-white/30 hover:scale-105"
            }`}
            style={{ background: c }}
          >
            {color === c && <Check size={11} className="text-black/70" />}
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-white/15" />
        <button
          type="button"
          className={toolBtn(false)}
          disabled={!canUndo && !draft}
          aria-label="撤销"
          onClick={undo}
          title="撤销上一步（Ctrl+Z）"
        >
          <Undo2 size={14} /> <span>撤销</span>
        </button>
        <button type="button" className={toolBtn(false)} disabled={!history.canRedo} aria-label="重做" onClick={redo} title="重做（Ctrl+Shift+Z）">
          <Redo2 size={14} />
        </button>
        <button
          type="button"
          className={toolBtn(false)}
          disabled={shapes.length === 0}
          aria-label="清空"
          onClick={clearAll}
          title="清空全部标注"
        >
          <Trash2 size={14} /> <span>清空</span>
        </button>

        </div>
        <div className="annotation-toolbar-actions">
          {!isDraft && !isRevision && <button type="button" aria-label="覆盖原文件"
            disabled={!hasEdits || busy || !canOverwrite}
            onClick={() => void saveToLibrary(true)}
            title={canOverwrite ? "将当前结果写回原文件，保留素材身份和操作记录，并更新画板与素材库" : "此格式不能覆盖原文件，请保存到素材库"}
            className="flex items-center gap-1.5 rounded border border-white/25 px-3 py-1.5 text-white transition-colors hover:bg-white/10 disabled:opacity-40">
            <FileCheck2 size={14} /> <span>覆盖原文件</span>
          </button>}
          {!isDraft && !isRevision && <button
            type="button"
            disabled={!hasEdits || busy || !annotator.saveToCanvas}
            aria-label="添加到画板"
            onClick={addToCanvas}
            title={!annotator.saveToCanvas ? "请先打开项目画板" : hasEdits ? "将标注图添加到当前画板，同时保存到素材库" : "请先画标注或裁剪/旋转"}
            className="flex items-center gap-1.5 rounded border border-white/25 px-3 py-1.5 text-white transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <LayoutDashboard size={14} /> <span>添加到画板</span>
          </button>}
          <button
            type="button"
            disabled={!hasEdits || busy}
            aria-label={busy ? "保存中…" : saveLabel}
            onClick={() => void saveToLibrary()}
            title={hasEdits ? saveLabel : "请先画标注或裁剪/旋转"}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
          >
            <Save size={14} /> <span>{busy ? "保存中…" : saveLabel}</span>
          </button>
          {!isDraft && <button
            type="button"
            disabled={!hasEdits || busy}
            aria-label="插入创作板"
            onClick={insertToBoard}
            title="插入创作板：标注图不进入素材库，仅插入当前创作板编辑器"
            className="flex items-center gap-1.5 rounded border border-white/25 px-3 py-1.5 text-white transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <TextCursorInput size={14} /> <span>插入创作板</span>
          </button>}
          <button
            type="button"
            disabled={busy}
            onClick={closeAnnotator}
            title="关闭（Esc）"
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
      </fieldset>
      {edit?.warning && <p role="status" className="border-b border-white/10 px-3 py-1.5 text-xs text-white/80">{edit.warning}</p>}

      {/* 画布区 */}
      <div ref={stageRef} tabIndex={-1} data-pan-mode={tool === "pan" || spaceHeld || viewport.dragging}
        className="annotation-stage relative flex flex-1 items-center justify-center overflow-hidden p-6 outline-none touch-none"
        style={{ pointerEvents: busy ? "none" : undefined, cursor: viewport.dragging ? "grabbing" : tool === "pan" || spaceHeld ? "grab" : undefined }}
        onPointerDownCapture={event => { if (isPanGesture(event)) viewport.onPointerDown(event); }}>
        {assetLoading ? (
          <p className="text-sm text-white/60">正在加载素材…</p>
        ) : assetError ? (
          <p className="text-sm text-red-300">{userErrorMessage(assetError, "素材暂时无法读取，请重新打开。")}</p>
        ) : !asset && !isDraft ? (
          <p className="text-sm text-white/60">素材不存在或已删除</p>
        ) : loadError ? (
          <p className="text-sm text-red-300">{userErrorMessage(loadError, "底图暂时无法读取，请重新打开。")}</p>
        ) : !base || !displaySize ? (
          <p className="text-sm text-white/60">正在加载底图…</p>
        ) : (
          <div className="relative shadow-2xl" style={{ width: dw, height: dh, transform: viewport.style.transform }}>
            {/* Keep the source's accessible name; Canvas paints it exactly once, including alpha. */}
            <img
              src={base.url}
              alt={isDraft ? "白底草稿" : asset?.name}
              draggable={false}
              className="absolute inset-0 h-full w-full select-none opacity-0 pointer-events-none"
            />
            <canvas ref={canvasRef} data-annotation-canvas className="absolute inset-0 h-full w-full pointer-events-none"
              style={{ visibility: replacesBase ? "hidden" : undefined }} />
            <canvas ref={draftCanvasRef} width={0} height={0} className="absolute inset-0 h-full w-full pointer-events-none" />
            <svg
              ref={overlayRef}
              viewBox={`0 0 ${dw} ${dh}`}
              className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                drawing.cancel();
                cancelCropDrag();
              }}
              onLostPointerCapture={cancelCropDrag}
              onContextMenu={e => { e.preventDefault(); drawing.finish(); }}
              onDoubleClick={() => { if (drawing.polyline.current) drawing.finish(); }}
            >
              {tool === "text" && shapes.map((shape, index) => shape.type !== "text" || textEdit?.index === index ? null :
                <polygon key={index} data-annotation-text={index} aria-label={shape.text} fill="transparent"
                  points={shape.points!.map(point => `${point.x * dw},${point.y * dh}`).join(" ")}
                  onPointerDown={event => { event.preventDefault(); event.stopPropagation(); setTextEdit({ index, shape }); }} />)}
              {tool === "crop" && cropRect && renderCropUI(cropRect)}
            </svg>
            {textEdit && <AnnotationTextEditor
              key={textEdit.index ?? "new"} shape={textEdit.shape} width={dw} height={dh}
              onChange={shape => setTextEdit({ ...textEdit, shape })}
              onCommit={commitText} onCancel={() => setTextEdit(null)} />}
          </div>
        )}
        {hasCropToolbar && <div ref={cropToolbarRef} className="annotation-crop-toolbar" role="toolbar" aria-label="裁剪操作"
          style={cropToolbarPosition} data-hidden={busy || cropDragging || viewport.dragging || !cropToolbarPosition || undefined}>
          <TacticalSelect aria-label="裁剪比例" value={cropPreset} onValueChange={selectCropPreset} disabled={busy}>
            <option value="free">自由</option>
            <option value="original">原图比例</option>
            {Object.keys(CROP_PRESETS).map(preset => <option key={preset} value={preset}>{preset}</option>)}
          </TacticalSelect>
          <button type="button" onClick={applyCrop} disabled={busy} title="应用裁剪（Enter / 双击框内）"
            className="flex items-center gap-1 rounded bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent/85">
            <Check size={13} aria-hidden="true" /> 应用裁剪
          </button>
          <button type="button" onClick={cancelCropMode} disabled={busy} aria-label="取消裁剪" title="取消裁剪（Esc）"
            className="flex items-center rounded px-2 py-1.5 text-xs text-white hover:bg-white/10">
            <X size={13} aria-hidden="true" />
          </button>
        </div>}
        {base && <button type="button" aria-label="图片居中" title="图片居中" disabled={!viewport.isPanned}
          className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded border border-white/20 bg-black/60 text-white/80 hover:bg-black/80 disabled:opacity-30"
          onClick={viewport.reset}><Focus size={16} aria-hidden="true" /></button>}
      </div>

      {/* 状态条 */}
      <div className="annotation-statusbar flex items-center justify-between border-t border-white/10 px-3 py-1.5 text-[11px] text-white/50">
        <span>
          {tool === "crop"
            ? "裁剪：拖手柄调整范围 · 框内拖动移动 · 框外拖拽重画 · Enter 应用 / Esc 取消"
            : `${isDraft ? `草稿 · ${base ? `${base.w}×${base.h}` : "…"}` : asset ? `${asset.name} · ${base ? `${base.w}×${base.h}` : "…"}` : ""}${
                shapes.length > 0 ? ` · 已画 ${shapes.length} 个标注` : ""
              }${ops.length > 0 ? " · 已裁剪/旋转" : ""}`}
        </span>
        {isDraft ? <span>保存后可作为参考图使用</span> : <span>
          在创作板选择「标注」维度，可使用这些标注
        </span>}
      </div>
    </div>,
    document.body
  );
}
