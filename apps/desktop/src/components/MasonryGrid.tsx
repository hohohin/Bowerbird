import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { Asset } from "../lib/types";

function parseColors(c: string | null | undefined): string[] {
  if (!c) return [];
  try {
    const v = JSON.parse(c);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function Thumb({ asset }: { asset: Asset }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const selected = useStore((s) => s.mode === "manage" && s.selectedIds.has(asset.id));
  const colors = useMemo(() => parseColors(asset.colors), [asset.colors]);

  // 懒加载：进入视口前不加载缩略图（千图级性能保障）。
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !asset.thumb_path) return;
    const path = asset.thumb_path;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            img.src = convertFileSrc(path);
            obs.disconnect();
          }
        }
      },
      { rootMargin: "300px" }
    );
    obs.observe(img);
    return () => obs.disconnect();
  }, [asset.thumb_path]);

  // 没有缩略图的占位（非图片格式或解码失败）。
  if (!asset.thumb_path) {
    return (
      <div className="mb-2 flex h-32 break-inside-avoid items-center justify-center rounded-md bg-panel2 text-xs text-muted">
        {asset.ext?.toUpperCase() ?? "?"}
      </div>
    );
  }

  // 瀑布流（CSS columns）抖动根因：缩略图加载前 <img> 高度为 0，加载完成撑高
  // → columns 反复重新平衡列高 → 整个网格持续重排。用 DB 已有的 width/height
  // 设 aspect-ratio，让占位高度等于最终高度，加载后高度不变，columns 不再重排。
  // SVG/PSD probe 为 0×0，回退到无 aspect-ratio（占比极少，不影响整体）。
  const ratio =
    asset.width && asset.height ? `${asset.width}/${asset.height}` : undefined;

  return (
    <div
      className={`mb-2 break-inside-avoid cursor-pointer overflow-hidden rounded-md ring-2 transition ${
        selected ? "ring-accent" : "ring-transparent hover:ring-edge"
      }`}
      onClick={(e) => {
        const st = useStore.getState();
        if (st.mode === "manage") st.toggleSelect(asset.id);
        else st.openDetail(asset.id);
        void e; // shift 多选已并入 manage 模式，不再需要修饰键
      }}
    >
      <img
        ref={imgRef}
        className="block w-full bg-panel2"
        style={{ aspectRatio: ratio }}
        loading="lazy"
        alt={asset.name}
        draggable={false}
      />
      {colors.length > 0 && (
        <div className="flex h-2 w-full">
          {colors.map((c, i) => (
            <div key={i} className="flex-1" style={{ background: c }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 瀑布流（CSS columns masonry + 缩略图懒加载 + 颜色前端过滤）。 */
export function MasonryGrid() {
  const assets = useStore((s) => s.assets);
  const colorFilter = useStore((s) => s.colorFilter);

  const filtered = useMemo(() => {
    if (!colorFilter) return assets;
    return assets.filter((a) => parseColors(a.colors).includes(colorFilter));
  }, [assets, colorFilter]);

  if (filtered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {assets.length === 0
          ? "还没有素材 —— 用顶部按钮导入图片或文件夹"
          : "当前筛选下无素材"}
      </div>
    );
  }

  return (
    <div className="columns-2 gap-2 p-2 md:columns-3 lg:columns-4 xl:columns-5 h-full overflow-y-auto">
      {filtered.map((a) => (
        <Thumb key={a.id} asset={a} />
      ))}
    </div>
  );
}
