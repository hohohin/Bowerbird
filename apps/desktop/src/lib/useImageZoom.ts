import { useCallback, useEffect, useRef, useState } from "react";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Opts {
  min?: number;
  max?: number;
  step?: number; // 每次滚轮缩放比例（factor = 1 ± step）
  dblScale?: number; // 双击放大的目标比例
}

/**
 * 图片滚轮缩放 + 拖动平移 hook。参考成熟图片查看器（macOS Preview / Eagle /
 * react-zoom-pan-pinch / photoSwipe）的共识交互：
 * - 滚轮：以光标为锚点缩放（zoom-to-cursor），deltaY<0 放大、>0 缩小。
 * - 拖动：按下拖动平移；scale>1 时 grab/grabbing 光标。
 * - 双击：1x ↔ dblScale 切换（同样以光标为中心）。
 * - src 变化（换图）自动 reset。
 *
 * 数学（transform-origin: center）：当前 transform = translate(tx,ty) scale(s)。
 * 设鼠标相对「当前 imgRect 中心」为 (cx,cy)（注意是 transform 后的盒子中心，
 * 已含 translate 偏移），缩放到 s'（k = s'/s）后让鼠标下的图片点不动：
 *   tx' = tx + cx·(1-k)，ty' = ty + cy·(1-k)
 * 推导：img 上某点经 transform 落在屏幕 imgRect.center + tx + p·s；要求缩放后该点
 * 仍在鼠标处，解出上式。
 */
export function useImageZoom(src?: string, opts: Opts = {}) {
  const min = opts.min ?? 1;
  const max = opts.max ?? 8;
  const step = opts.step ?? 0.15;
  const dblScale = opts.dblScale ?? 2;

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  // 同步最新值，供 wheel/mousemove 闭包读取，避免 stale state。
  const stRef = useRef({ scale: 1, tx: 0, ty: 0 });
  stRef.current = { scale, tx, ty };
  const dragRef = useRef<{ mx: number; my: number; tx: number; ty: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // 换图（src 变）→ reset，避免上一张的缩放/平移带到新图。
  useEffect(() => {
    reset();
  }, [src, reset]);

  // 原生 wheel 绑定：必须 passive:false 才能 preventDefault 阻止页面/容器滚动。
  // React onWheel 在部分浏览器为 passive，preventDefault 无效，故走原生 addEventListener。
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const { scale: s, tx: x, ty: y } = stRef.current;
      const factor = e.deltaY < 0 ? 1 + step : 1 / (1 + step);
      const next = clamp(s * factor, min, max);
      if (next === s) return;
      const k = next / s;
      setTx(x + cx * (1 - k));
      setTy(y + cy * (1 - k));
      setScale(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [min, max, step]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // preventDefault 防止 img 原生拖拽 / 选区；stopPropagation 不冒泡到背景关闭层。
    e.preventDefault();
    e.stopPropagation();
    const { tx, ty } = stRef.current;
    dragRef.current = { mx: e.clientX, my: e.clientY, tx, ty };
    setDragging(true);
  }, []);

  // 拖动 move/up 挂 window：拖出 img 范围仍能继续平移 / 释放。
  useEffect(() => {
    function move(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      setTx(d.tx + (e.clientX - d.mx));
      setTy(d.ty + (e.clientY - d.my));
    }
    function up() {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(false);
      }
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const el = imgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const { scale: s, tx: x, ty: y } = stRef.current;
      if (s > 1.001) {
        setScale(1);
        setTx(0);
        setTy(0);
      } else {
        const k = dblScale / s;
        setTx(x + cx * (1 - k));
        setTy(y + cy * (1 - k));
        setScale(dblScale);
      }
    },
    [dblScale]
  );

  const isZoomed = scale > 1.001;
  const style: React.CSSProperties = {
    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    transformOrigin: "center center",
    cursor: isZoomed ? (dragging ? "grabbing" : "grab") : "zoom-in",
  };

  return { imgRef, style, onMouseDown, onDoubleClick, isZoomed, reset };
}
