import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Crop,
  Eraser,
  MoveUpRight,
  RotateCcw,
  RotateCw,
  Save,
  Square,
  TextCursorInput,
  Undo2,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { chipName } from "./creation/schema";
import type {
  AnnotationMeta,
  AnnotationShape,
  AnnotationTransformOp,
  PromptedAsset,
} from "../lib/types";

/**
 * 图片标注面板（全屏遮罩，Lightbox 同级 z-[90]）：截图软件式在图上画框/箭头 + 裁剪/旋转。
 * 右键菜单 openAnnotator 唤起，App 最外层挂单实例（store.annotator 驱动）。
 *
 * 底图变换：ops 序列（rotate 90° 步进 / crop 归一化矩形）按操作顺序即时生效；每次变换把
 * 已有形状坐标映射到新坐标系（形状锚定图像内容），显示与导出都基于「原图 → ops」的步进
 * 像素变换，导出只输出最终图（裁剪后区域）。
 *
 * 坐标体系：形状存 0-1 相对当前底图坐标；导出换算火山 Seedream 交互编辑的 0-999 归一化
 * 整数（docs.volcengine.com/docs/82379/2582775）——坐标相对最终输出图 = 实际发给模型的
 * 参考图。rect → `<bbox>x1 y1 x2 y2</bbox>`，arrow → 起终点两个 `<point>`。
 *
 * 底图经 Rust 读为 data URL（asset 协议的 convertFileSrc 是跨域源，画进 canvas 会污染
 * 画布、toDataURL 抛 SecurityError）。导出 = 最终底图烧录标注 → 双出口：
 * 保存到素材库（analyses kind=annotation 记坐标）；插入创作板（临时文件 + sidecar 不入库，
 * 「标注」维度随 chip 自动注入，serialize 时展开为 `@图名 的【标注】：<bbox>…`）。
 * 撤销 = 快照栈（形状 + ops 全量快照），画形状/裁剪/旋转/清空皆可撤销。
 */

/** 面板内绘制形状：坐标 0-1 相对当前底图；strokeRatio = 线宽/底图宽（分辨率无关）。 */
type DrawShape = {
  type: "rect" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeRatio: number;
};

type BaseOp = AnnotationTransformOp;
type Tool = "rect" | "arrow" | "crop";

const COLORS = ["#ff4d4d", "#ffd21e", "#3ddc84", "#4d9fff", "#ffffff"];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// 0-1 → 火山 0-999 归一化整数：round(v*1000) 后 clamp（右下角 999,999）。
const v999 = (v: number) => Math.max(0, Math.min(999, Math.round(v * 1000)));

function shapeToken(s: DrawShape): string {
  if (s.type === "rect") {
    const x1 = v999(Math.min(s.x1, s.x2));
    const y1 = v999(Math.min(s.y1, s.y2));
    const x2 = v999(Math.max(s.x1, s.x2));
    const y2 = v999(Math.max(s.y1, s.y2));
    return `<bbox>${x1} ${y1} ${x2} ${y2}</bbox>`;
  }
  return `<point>${v999(s.x1)} ${v999(s.y1)}</point> → <point>${v999(s.x2)} ${v999(s.y2)}</point>`;
}

// ---- 底图变换几何（归一化坐标）----

/** 单点过 op：rotate CW (x,y)→(1-y,x)、CCW →(y,1-x)；crop 平移+按跨度缩放。 */
function opPoint(op: BaseOp, x: number, y: number): [number, number] {
  if (op.kind === "rotate") {
    return op.dir === 1 ? [1 - y, x] : [y, 1 - x];
  }
  const sx = Math.max(1e-6, op.x2 - op.x1);
  const sy = Math.max(1e-6, op.y2 - op.y1);
  return [(x - op.x1) / sx, (y - op.y1) / sy];
}

/** 像素尺寸过 op：rotate 宽高互换；crop 按跨度缩放。 */
function opDims(op: BaseOp, w: number, h: number): { w: number; h: number } {
  if (op.kind === "rotate") return { w: h, h: w };
  const sx = Math.max(1e-6, op.x2 - op.x1);
  const sy = Math.max(1e-6, op.y2 - op.y1);
  return { w: Math.max(1, Math.round(w * sx)), h: Math.max(1, Math.round(h * sy)) };
}

/** 形状过 op：端点随内容走；线宽像素不变、基准宽变化 → 比例 = 旧比例 * 旧宽 / 新宽。 */
function mapShape(s: DrawShape, op: BaseOp, oldW: number, oldH: number): DrawShape {
  const [x1, y1] = opPoint(op, s.x1, s.y1);
  const [x2, y2] = opPoint(op, s.x2, s.y2);
  const d = opDims(op, oldW, oldH);
  return { ...s, x1, y1, x2, y2, strokeRatio: (s.strokeRatio * oldW) / d.w };
}

/** pristine 原图按序应用 ops → 当前底图 canvas（步进像素变换；显示与导出共用）。空序列返回 null（直接用原图）。 */
function buildBaseCanvas(img: HTMLImageElement, ops: BaseOp[]): HTMLCanvasElement | null {
  if (ops.length === 0) return null;
  let src: HTMLCanvasElement | HTMLImageElement = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  for (const op of ops) {
    const d = opDims(op, w, h);
    const canvas = document.createElement("canvas");
    canvas.width = d.w;
    canvas.height = d.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (op.kind === "rotate") {
      // CW：translate(新宽,0)+rotate(90°)；CCW：translate(0,新高)+rotate(-90°)。
      if (op.dir === 1) {
        ctx.translate(d.w, 0);
        ctx.rotate(Math.PI / 2);
      } else {
        ctx.translate(0, d.h);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.drawImage(src, 0, 0);
    } else {
      ctx.drawImage(
        src,
        op.x1 * w,
        op.y1 * h,
        (op.x2 - op.x1) * w,
        (op.y2 - op.y1) * h,
        0,
        0,
        d.w,
        d.h
      );
    }
    src = canvas;
    w = d.w;
    h = d.h;
  }
  return src as HTMLCanvasElement;
}

/** 箭头头部两翼端点（随线宽缩放的等腰翼，预览 SVG 与导出 canvas 共用）。 */
function arrowWings(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w: number
): [[number, number], [number, number]] {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(w * 3, w + 6);
  const wing = (offset: number): [number, number] => [
    x2 + Math.cos(ang + offset) * len,
    y2 + Math.sin(ang + offset) * len,
  ];
  return [wing(Math.PI * 0.82), wing(-Math.PI * 0.82)];
}

/** 把形状按目标尺寸 (w,h) 画进 canvas（导出烧录用）。 */
function drawShapeCanvas(
  ctx: CanvasRenderingContext2D,
  s: DrawShape,
  w: number,
  h: number
) {
  const lw = Math.max(1, s.strokeRatio * w);
  ctx.strokeStyle = s.color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.type === "rect") {
    ctx.strokeRect(
      Math.min(s.x1, s.x2) * w,
      Math.min(s.y1, s.y2) * h,
      Math.abs(s.x2 - s.x1) * w,
      Math.abs(s.y2 - s.y1) * h
    );
    return;
  }
  const x1 = s.x1 * w;
  const y1 = s.y1 * h;
  const x2 = s.x2 * w;
  const y2 = s.y2 * h;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  const [p1, p2] = arrowWings(x1, y1, x2, y2, lw);
  ctx.moveTo(p1[0], p1[1]);
  ctx.lineTo(x2, y2);
  ctx.lineTo(p2[0], p2[1]);
  ctx.stroke();
}

export function ImageAnnotator() {
  const annotator = useStore((s) => s.annotator);
  const closeAnnotator = useStore((s) => s.closeAnnotator);
  const insertAnnotatedToBoard = useStore((s) => s.insertAnnotatedToBoard);
  const assets = useStore((s) => s.assets);
  const currentProjectId = useStore((s) => s.currentProjectId);

  const asset = annotator ? assets.find((a) => a.id === annotator.assetId) : undefined;
  const storePath = asset?.store_path ?? null;
  const open = !!annotator;

  // 底图 data URL（Rust 读取）+ 预解码元素（导出 drawImage 用）。nat 由预加载解出——
  // 不能依赖渲染中 <img> 的 onLoad：显示区尺寸依赖 nat，nat 又要等 <img> 渲染，互相等会
  // 死锁在「正在加载底图」。预解码元素已 onload，导出画布 drawImage 直接可用（无跨域污染）。
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!open || !storePath) {
      setImgUrl(null);
      setLoadError(null);
      setNat(null);
      baseImgRef.current = null;
      return;
    }
    let cancelled = false;
    setImgUrl(null);
    setLoadError(null);
    setNat(null);
    api
      .readImageDataUrl(storePath)
      .then((url) => {
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          baseImgRef.current = img;
          setImgUrl(url);
          setNat({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.onerror = () => {
          if (!cancelled) setLoadError("图片解码失败");
        };
        img.src = url;
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, storePath]);

  // 形状 / 底图变换 / 撤销快照栈；换图重置。
  const [shapes, setShapes] = useState<DrawShape[]>([]);
  const [ops, setOps] = useState<BaseOp[]>([]);
  const [undoStack, setUndoStack] = useState<{ shapes: DrawShape[]; ops: BaseOp[] }[]>([]);
  const [draft, setDraft] = useState<DrawShape | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState(COLORS[0]);
  const [pen, setPen] = useState(4); // 线宽（显示像素，提交时按显示宽换算 strokeRatio）
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setShapes([]);
    setOps([]);
    setUndoStack([]);
    setDraft(null);
    setBusy(false);
  }, [annotator?.assetId]);

  // 当前底图 = 原图按序应用 ops（无变换 = 原图本身）。显示用 url/dims，导出用 canvas。
  const [base, setBase] = useState<{ url: string; w: number; h: number } | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!imgUrl || !nat) {
      baseCanvasRef.current = null;
      setBase(null);
      return;
    }
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

  function pushUndo() {
    setUndoStack((s) => [...s, { shapes, ops }]);
  }

  function undo() {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack(undoStack.slice(0, -1));
    setShapes(last.shapes);
    setOps(last.ops);
  }

  // Esc 关闭 / Ctrl+Z 撤销。
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAnnotator();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closeAnnotator, undoStack, shapes, ops]);

  function rotate(dir: 1 | -1) {
    if (!base) return;
    pushUndo();
    const op: BaseOp = { kind: "rotate", dir };
    setOps([...ops, op]);
    setShapes(shapes.map((s) => mapShape(s, op, base.w, base.h)));
  }

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
    if (op.x2 - op.x1 > 0.999 && op.y2 - op.y1 > 0.999) return; // 全图 = 无操作
    pushUndo();
    setOps([...ops, op]);
    setShapes(shapes.map((s) => mapShape(s, op, base.w, base.h)));
    setTool("rect"); // 裁完回画框，继续标注（再裁可重点工具）
  }

  function toRel(e: React.PointerEvent): { x: number; y: number } {
    const r = overlayRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !displaySize) return;
    e.preventDefault();
    const p = toRel(e);
    setDraft({
      type: tool === "crop" ? "rect" : tool,
      x1: p.x,
      y1: p.y,
      x2: p.x,
      y2: p.y,
      color,
      strokeRatio: pen / displaySize.w,
    });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!draft) return;
    const p = toRel(e);
    setDraft({ ...draft, x2: p.x, y2: p.y });
  }

  function onPointerUp() {
    if (!draft) return;
    const dx = Math.abs(draft.x2 - draft.x1);
    const dy = Math.abs(draft.y2 - draft.y1);
    if (tool === "crop") {
      if (dx > 0.01 && dy > 0.01) commitCrop(draft.x1, draft.y1, draft.x2, draft.y2);
      setDraft(null);
      return;
    }
    // 误触过滤：框需两向都有跨度，箭头需最小长度（约图宽 2%）。
    const ok = draft.type === "rect" ? dx > 0.008 && dy > 0.008 : Math.hypot(dx, dy) > 0.02;
    if (ok) {
      pushUndo();
      setShapes((s) => [...s, draft]);
    }
    setDraft(null);
  }

  function clearAll() {
    if (shapes.length === 0) return;
    pushUndo();
    setShapes([]);
  }

  /** 导出：最终底图（原图 → ops）烧录标注 → dataURL + 火山格式坐标元数据（相对输出图）。 */
  async function buildOutput(): Promise<{ dataUrl: string; meta: AnnotationMeta } | null> {
    const img = baseImgRef.current;
    if (!img || !asset || !base) return null;
    const w = base.w;
    const h = base.h;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    const jpeg = asset.ext === "jpg" || asset.ext === "jpeg";
    if (jpeg) {
      // 透明底画进 JPEG 会变黑，先铺白。
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(baseCanvasRef.current ?? img, 0, 0, w, h);
    for (const s of shapes) drawShapeCanvas(ctx, s, w, h);
    const dataUrl = jpeg
      ? canvas.toDataURL("image/jpeg", 0.92)
      : canvas.toDataURL("image/png");
    const meta: AnnotationMeta = {
      schema_version: 1,
      source_asset_id: asset.id,
      source_store_path: asset.store_path ?? "",
      image: { width: w, height: h },
      transform: ops.length > 0 ? ops : undefined,
      shapes: shapes.map<AnnotationShape>((s) => ({
        type: s.type,
        x1: v999(s.type === "rect" ? Math.min(s.x1, s.x2) : s.x1),
        y1: v999(s.type === "rect" ? Math.min(s.y1, s.y2) : s.y1),
        x2: v999(s.type === "rect" ? Math.max(s.x1, s.x2) : s.x2),
        y2: v999(s.type === "rect" ? Math.max(s.y1, s.y2) : s.y2),
        color: s.color,
        width: Math.max(1, Math.round(s.strokeRatio * w)),
        token: shapeToken(s),
      })),
    };
    return { dataUrl, meta };
  }

  async function saveToLibrary() {
    if (busy) return;
    setBusy(true);
    try {
      const out = await buildOutput();
      if (!out) return;
      await api.saveAnnotatedImage({
        dataUrl: out.dataUrl,
        fileName: `${chipName(asset!)}-标注`,
        projectId: currentProjectId,
        annotationJson: JSON.stringify(out.meta),
      });
      notifySuccess("标注图已保存到素材库");
      closeAnnotator();
    } catch (e) {
      notifyError(e, "保存标注图失败");
    } finally {
      setBusy(false);
    }
  }

  async function insertToBoard() {
    if (busy) return;
    setBusy(true);
    try {
      const out = await buildOutput();
      if (!out) return;
      const temp = await api.saveAnnotationTemp({
        dataUrl: out.dataUrl,
        fileName: `${chipName(asset!)}-标注`,
        // sidecar 随文件落盘：generation_history 反查兜底据此合成，复用提示词不丢本图。
        annotationJson: JSON.stringify(out.meta),
      });
      // 「标注」维度直接挂在注入对象上（不进 DB，无 list_prompted_assets 合成路径）。
      const prompted: PromptedAsset = {
        ...temp,
        annotation: out.meta,
        sections: [{ title: "标注", body: out.meta.shapes.map((s) => s.token).join("；") }],
      };
      closeAnnotator();
      insertAnnotatedToBoard(prompted);
      notifySuccess("标注图已插入创作板（未入库）");
    } catch (e) {
      notifyError(e, "插入创作板失败");
    } finally {
      setBusy(false);
    }
  }

  if (!annotator) return null;

  const dw = displaySize?.w ?? 0;
  const dh = displaySize?.h ?? 0;
  const strokeW = (s: DrawShape) => Math.max(1, s.strokeRatio * dw);

  const renderShape = (s: DrawShape, key: string) => {
    const w = strokeW(s);
    if (s.type === "rect") {
      return (
        <rect
          key={key}
          x={Math.min(s.x1, s.x2) * dw}
          y={Math.min(s.y1, s.y2) * dh}
          width={Math.abs(s.x2 - s.x1) * dw}
          height={Math.abs(s.y2 - s.y1) * dh}
          fill="none"
          stroke={s.color}
          strokeWidth={w}
          rx={w * 0.4}
        />
      );
    }
    const x1 = s.x1 * dw;
    const y1 = s.y1 * dh;
    const x2 = s.x2 * dw;
    const y2 = s.y2 * dh;
    const [p1, p2] = arrowWings(x1, y1, x2, y2, w);
    return (
      <polyline
        key={key}
        points={`${x1},${y1} ${x2},${y2} ${p1[0]},${p1[1]} ${x2},${y2} ${p2[0]},${p2[1]}`}
        fill="none"
        stroke={s.color}
        strokeWidth={w}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  };

  /** 裁剪拖拽预览：选区外压暗 + 白色虚线框（区别于标注框）。 */
  const renderCropDraft = (s: DrawShape) => {
    const x = Math.min(s.x1, s.x2) * dw;
    const y = Math.min(s.y1, s.y2) * dh;
    const w = Math.abs(s.x2 - s.x1) * dw;
    const h = Math.abs(s.y2 - s.y1) * dh;
    const dim = "rgba(0,0,0,0.45)";
    return (
      <g key="crop-draft">
        <rect x={0} y={0} width={dw} height={y} fill={dim} />
        <rect x={0} y={y + h} width={dw} height={Math.max(0, dh - y - h)} fill={dim} />
        <rect x={0} y={y} width={x} height={h} fill={dim} />
        <rect x={x + w} y={y} width={Math.max(0, dw - x - w)} height={h} fill={dim} />
        <rect x={x} y={y} width={w} height={h} fill="none" stroke="#ffffff" strokeWidth={1.5} strokeDasharray="6 4" />
      </g>
    );
  };

  const toolBtn = (active: boolean) =>
    `flex items-center gap-1.5 rounded px-2.5 py-1.5 transition-colors ${
      active ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
    }`;

  const canUndo = undoStack.length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label="图片标注"
    >
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-2 text-xs text-white">
        <button type="button" className={toolBtn(tool === "rect")} onClick={() => setTool("rect")}>
          <Square size={14} /> 画框
        </button>
        <button type="button" className={toolBtn(tool === "arrow")} onClick={() => setTool("arrow")}>
          <MoveUpRight size={14} /> 箭头
        </button>
        <button type="button" className={toolBtn(tool === "crop")} onClick={() => setTool("crop")}>
          <Crop size={14} /> 裁剪
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
        <label className="flex items-center gap-2 text-white/70">
          粗细
          <input
            type="range"
            min={2}
            max={16}
            step={1}
            value={pen}
            onChange={(e) => setPen(Number(e.target.value))}
            className="w-24 accent-[#4868ff]"
          />
        </label>
        <div className="mx-1 h-4 w-px bg-white/15" />
        <button
          type="button"
          className={toolBtn(false)}
          disabled={!canUndo}
          onClick={undo}
          title="撤销上一步（Ctrl+Z）"
        >
          <Undo2 size={14} /> 撤销
        </button>
        <button
          type="button"
          className={toolBtn(false)}
          disabled={shapes.length === 0}
          onClick={clearAll}
          title="清空全部标注"
        >
          <Eraser size={14} /> 清空
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={shapes.length === 0 || busy}
            onClick={saveToLibrary}
            title={shapes.length === 0 ? "请先画至少一个标注" : undefined}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
          >
            <Save size={14} /> 保存到素材库
          </button>
          <button
            type="button"
            disabled={shapes.length === 0 || busy}
            onClick={insertToBoard}
            title={shapes.length === 0 ? "请先画至少一个标注" : "标注图不进入素材库，仅插入当前创作板编辑器"}
            className="flex items-center gap-1.5 rounded border border-white/25 px-3 py-1.5 text-white transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <TextCursorInput size={14} /> 插入创作板 · 不入库
          </button>
          <button
            type="button"
            onClick={closeAnnotator}
            title="关闭（Esc）"
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* 画布区 */}
      <div ref={stageRef} className="relative flex flex-1 items-center justify-center overflow-hidden p-6">
        {!asset ? (
          <p className="text-sm text-white/60">素材不存在或已删除</p>
        ) : loadError ? (
          <p className="text-sm text-red-300">底图加载失败：{loadError}</p>
        ) : !base || !displaySize ? (
          <p className="text-sm text-white/60">正在加载底图…</p>
        ) : (
          <div className="relative shadow-2xl" style={{ width: dw, height: dh }}>
            <img
              src={base.url}
              alt={asset.name}
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
            />
            <svg
              ref={overlayRef}
              viewBox={`0 0 ${dw} ${dh}`}
              className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDraft(null)}
              onContextMenu={(e) => e.preventDefault()}
            >
              {shapes.map((s, i) => renderShape(s, `s${i}`))}
              {draft && (tool === "crop" ? renderCropDraft(draft) : renderShape(draft, "draft"))}
            </svg>
          </div>
        )}
      </div>

      {/* 状态条 */}
      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1.5 text-[11px] text-white/50">
        <span>
          {asset ? `${asset.name} · ${base ? `${base.w}×${base.h}` : "…"}` : ""}
          {shapes.length > 0 && ` · 已画 ${shapes.length} 个标注`}
          {ops.length > 0 && ` · 已裁剪/旋转`}
        </span>
        <span>
          坐标按火山 Seedream 归一化（0-999）记录，相对最终输出图；创作板选「标注」维度即注入
          <code className="mx-1 rounded bg-white/10 px-1">&lt;bbox&gt;</code>/
          <code className="mx-1 rounded bg-white/10 px-1">&lt;point&gt;</code>
          坐标
        </span>
      </div>
    </div>,
    document.body
  );
}
