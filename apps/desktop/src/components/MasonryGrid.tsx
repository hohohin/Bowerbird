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
  // 反推全局可见：本缩略图正在反推 / 在队列里。角标点击 = 取消（运行中 kill 子进程 / 排队中移出队列）。
  const describeStatus = useStore((s) =>
    s.describingId === asset.id
      ? "running"
      : s.describeQueue.some((q) => q.assetId === asset.id)
        ? "queued"
        : null
  );
  const queuePos = useStore((s) => {
    const i = s.describeQueue.findIndex((q) => q.assetId === asset.id);
    return i >= 0 ? i + 1 : 0;
  });
  const cancelDescribe = useStore((s) => s.cancelDescribe);

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
      className={`relative mb-2 break-inside-avoid cursor-pointer overflow-hidden rounded-md ring-2 transition ${
        selected ? "ring-accent" : "ring-transparent hover:ring-edge"
      }`}
      onClick={() => {
        const st = useStore.getState();
        // 创作板打开 = 挑图上下文：点瀑布流图即插入编辑器（等同 @，但无需先打 @）。
        // @ 挑图态（boardPickMode）是同一条路径的「显式高亮」版本，插入后退出挑图态。
        if (st.boardOpen) {
          window.dispatchEvent(
            new CustomEvent("bowerbird://board-asset-picked", { detail: asset.id })
          );
          if (st.boardPickMode) st.finishBoardImagePick();
        } else if (st.mode === "manage") st.toggleSelect(asset.id);
        else st.openDetail(asset.id);
      }}
    >
      {describeStatus && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            cancelDescribe(asset.id);
          }}
          className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur transition hover:bg-red-500/80"
          title={
            describeStatus === "running" ? "反推中，点击取消" : `排队 ${queuePos}，点击移除`
          }
        >
          {describeStatus === "running" ? (
            <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-white/40 border-t-white" />
          ) : (
            <span>⏳</span>
          )}
          <span>{describeStatus === "running" ? "反推中" : `排队 ${queuePos}`}</span>
        </button>
      )}
      {asset.source === "codex" && (
        <span
          className="absolute left-1 top-1 z-10 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
          title="codex 生成图"
        >
          ✨
        </span>
      )}
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

/** 瀑布流（CSS columns masonry + 缩略图懒加载）。颜色筛选走后端（App refresh 按 colorFilter 分流），非前端过滤。 */
export function MasonryGrid() {
  const assets = useStore((s) => s.assets);
  const boardOpen = useStore((s) => s.boardOpen);
  const boardPickMode = useStore((s) => s.boardPickMode);

  const filtered = assets;

  if (filtered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {assets.length === 0
          ? boardOpen
            ? "还没有反推过的图 —— 先在详情页给一些图点「反推」，它们就会出现在这里供创作板挑选"
            : "还没有素材 —— 用顶部按钮导入图片或文件夹"
          : "当前筛选下无素材"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {boardPickMode && (
        <div className="relative shrink-0 overflow-hidden border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
          <div className="absolute inset-y-0 left-0 w-24 animate-pulse bg-accent/20" />
          <span className="relative">👆 请选择一张图片插入到 @ 位置</span>
        </div>
      )}
      {/* 滚动容器（固定高度 + 竖向滚动）与 columns 容器必须分离：
          columns 一旦有固定高度，多余内容会横向溢出开新列 → 横向滚动。
          内层 columns 不设高度，内容平分到 N 列后纵向增长，由本层竖向滚动。 */}
      <div
        className={`h-full overflow-y-auto ${
          boardPickMode ? "cursor-crosshair ring-2 ring-inset ring-accent/40" : ""
        }`}
      >
        <div className="columns-2 gap-2 p-2 md:columns-3 lg:columns-4 xl:columns-5">
          {filtered.map((a) => (
            <Thumb key={a.id} asset={a} />
          ))}
        </div>
      </div>
    </div>
  );
}
