import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../../store";
import type { Asset } from "../../lib/types";

type Hover =
  | { kind: "image"; assetId: string }
  | { kind: "keyword"; body: string }
  | null;

/**
 * 创作板编辑框 chip 的交互浮层。ProseMirror 渲染的 image/keyword chip 是非 React DOM，
 * 这里通过事件委托在编辑器宿主 div 上捕获 mousemove/click：
 * - image chip：hover 2s 弹放大图（与瀑布流 hover 一致的边界翻转/滚动收回），
 *   click → store.focusAsset → 瀑布流滚动定位 + 闪烁高亮。
 * - keyword chip：hover ~0.3s 弹该维度的反推正文（读 chip 上 data-body 快照，即插入时
 *   所属素材的 CaptionSection.body）。
 *
 * 浮层 portal 到 body，避开外层 overflow 裁剪。image 放大图 src / 尺寸取自 store 里的
 * asset.store_path + width/height（chip attrs 只存了 thumb，不够清晰且无原图比例）。
 */
export function BoardChipPreview({ hostRef }: { hostRef: RefObject<HTMLDivElement> }) {
  const assets = useStore((s) => s.assets);
  const promptedAssets = useStore((s) => s.promptedAssets);
  const focusAsset = useStore((s) => s.focusAsset);

  const assetMap = useMemo(() => {
    const m = new Map<string, Asset>();
    for (const a of promptedAssets) m.set(a.id, a);
    for (const a of assets) m.set(a.id, a);
    return m;
  }, [assets, promptedAssets]);

  const [hover, setHover] = useState<Hover>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);
  const hoverRef = useRef<Hover>(null);
  hoverRef.current = hover;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    function onMove(e: MouseEvent) {
      const t = e.target as HTMLElement;
      const imgChip = t.closest("[data-asset-id]") as HTMLElement | null;
      const kwChip = imgChip ? null : (t.closest("[data-keyword]") as HTMLElement | null);

      let next: Hover = null;
      if (imgChip) next = { kind: "image", assetId: imgChip.getAttribute("data-asset-id") ?? "" };
      else if (kwChip) next = { kind: "keyword", body: kwChip.getAttribute("data-body") ?? "" };

      setMouse({ x: e.clientX, y: e.clientY });

      const cur = hoverRef.current;
      const same =
        cur?.kind === next?.kind &&
        ((cur?.kind === "image" && next?.kind === "image" && cur.assetId === next.assetId) ||
          (cur?.kind === "keyword" && next?.kind === "keyword" && cur.body === next.body));
      if (same) return; // 同一 chip：仅更新鼠标坐标，不重置定时器
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
      setHover(next);
      if (next) {
        const delay = next.kind === "image" ? 2000 : 300;
        timer.current = setTimeout(() => setVisible(true), delay);
      }
    }

    function onLeave() {
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
      setHover(null);
    }

    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      const imgChip = t.closest("[data-asset-id]") as HTMLElement | null;
      const id = imgChip?.getAttribute("data-asset-id");
      if (!id) return;
      focusAsset(id);
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
    }

    // 滚动即收回（捕获阶段：内部 overflow-y-auto 容器滚动也能收到，与 MasonryGrid 一致）
    function onScroll() {
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
    }

    host.addEventListener("mousemove", onMove);
    host.addEventListener("mouseleave", onLeave);
    host.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseleave", onLeave);
      host.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hostRef, focusAsset]);

  let imgPortal = null;
  if (visible && hover?.kind === "image") {
    const asset = assetMap.get(hover.assetId);
    const src = asset?.store_path && !asset.duration ? convertFileSrc(asset.store_path) : null;
    if (src && asset) {
      // 原图比例 + 最长边 360px（chip rect ×2 太小看不清；与瀑布流体感一致而非像素一致）
      const MAX = 360;
      let w = asset.width || MAX;
      let h = asset.height || MAX;
      if (w >= h) {
        if (w > MAX) { h = (h * MAX) / w; w = MAX; }
      } else {
        if (h > MAX) { w = (w * MAX) / h; h = MAX; }
      }
      const off = 18;
      const pad = 8;
      let left = mouse.x + off;
      let top = mouse.y + off;
      if (left + w > window.innerWidth - pad) left = mouse.x - w - off;
      if (top + h > window.innerHeight - pad) top = mouse.y - h - off;
      left = Math.max(pad, left);
      top = Math.max(pad, top);
      imgPortal = createPortal(
        <img
          src={src}
          alt=""
          draggable={false}
          className="pointer-events-none fixed z-30 rounded-md border border-edge bg-panel object-contain shadow-xl"
          style={{ left, top, width: w, height: h }}
        />,
        document.body
      );
    }
  }

  let kwPortal = null;
  if (visible && hover?.kind === "keyword" && hover.body) {
    const width = 320;
    const off = 14;
    const pad = 8;
    let left = mouse.x + off;
    let top = mouse.y + off;
    if (left + width > window.innerWidth - pad) left = mouse.x - width - off;
    if (top + 220 > window.innerHeight - pad) top = mouse.y - 220 - off;
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    kwPortal = createPortal(
      <div
        className="pointer-events-none fixed z-40 max-h-72 w-80 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-panel p-2 text-xs leading-5 text-ink shadow-xl"
        style={{ left, top }}
      >
        {hover.body}
      </div>,
      document.body
    );
  }

  return (
    <>
      {imgPortal}
      {kwPortal}
    </>
  );
}
