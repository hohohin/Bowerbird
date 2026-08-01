import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { api } from "../lib/api";
import { setDragAssets } from "../lib/dragPayload";
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

function Thumb({
  asset,
  group,
}: {
  asset: Asset;
  group?: Asset[];
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const selected = useStore((s) => s.mode === "manage" && s.selectedIds.has(asset.id));
  const boardOpen = useStore((s) => s.boardOpen);
  const openContextMenu = useStore((s) => s.openContextMenu);
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

  // 同流程合并：组内 >1 张才显轮播。组到达 / 变化时回到末位（最新一张 = 列表里展示的那张）。
  const groupLen = group && group.length > 1 ? group.length : 0;
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(groupLen > 0 ? groupLen - 1 : 0);
  }, [groupLen]);
  const shown: Asset = groupLen > 0 ? group![idx] ?? asset : asset;
  const colors = useMemo(() => parseColors(shown.colors), [shown.colors]);

  function step(delta: number) {
    setIdx((cur) => {
      if (!group) return cur;
      return Math.max(0, Math.min(group.length - 1, cur + delta));
    });
  }

  // 懒加载：进入视口前不加载缩略图（千图级性能保障）。key 跟随 shown.thumb_path ——
  // 轮播切过程图时若仍在视口，observer 立即触发设 src。
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !shown.thumb_path) return;
    const path = shown.thumb_path;
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
  }, [shown.thumb_path]);

  // 没有缩略图的占位（非图片格式或解码失败）。
  if (!shown.thumb_path) {
    return (
      <div className="mb-2 flex h-32 break-inside-avoid items-center justify-center rounded-md bg-panel2 text-xs text-muted">
        {shown.ext?.toUpperCase() ?? "?"}
      </div>
    );
  }

  // 瀑布流（CSS columns）抖动根因：缩略图加载前 <img> 高度为 0，加载完成撑高
  // → columns 反复重新平衡列高 → 整个网格持续重排。用 DB 已有的 width/height
  // 设 aspect-ratio，让占位高度等于最终高度，加载后高度不变，columns 不再重排。
  const ratio =
    shown.width && shown.height ? `${shown.width}/${shown.height}` : undefined;

  // hover 放大预览：鼠标悬浮缩略图 2.8s 后弹出放大图（portal 到 body，避开外层 overflow 裁剪），
  // 移走即消失。放大尺寸 = 缩略图当前渲染尺寸 × 200%（放大镜式，随列宽变化）。视频/无原图时不启用。
  const previewSrc =
    shown.store_path && !shown.duration ? convertFileSrc(shown.store_path) : null;
  const [preview, setPreview] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function onEnter(e: MouseEvent<HTMLDivElement>) {
    if (!previewSrc) return;
    mouseRef.current = { x: e.clientX, y: e.clientY };
    // 2.8s 延迟：到点时取缩略图实际渲染尺寸，×2 作为放大尺寸（保证对每张图「200%」都真正成立）。
    hoverTimer.current = setTimeout(() => {
      const rect = imgRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return;
      setPreview({ ...mouseRef.current, w: rect.width * 2, h: rect.height * 2 });
    }, 2800);
  }
  function onMove(e: MouseEvent<HTMLDivElement>) {
    mouseRef.current = { x: e.clientX, y: e.clientY };
    // hover 期间缩略图尺寸不变，只跟随鼠标更新位置。
    setPreview((p) => (p ? { ...p, x: e.clientX, y: e.clientY } : p));
  }
  function onLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
  }
  // 浮层定位：默认鼠标右下偏移，靠右/下边时翻转到左/上，留 pad 不贴边。尺寸跟随缩略图×2。
  let previewLeft = 0;
  let previewTop = 0;
  if (preview) {
    const off = 18;
    const pad = 8;
    previewLeft = preview.x + off;
    previewTop = preview.y + off;
    if (previewLeft + preview.w > window.innerWidth - pad)
      previewLeft = preview.x - preview.w - off;
    if (previewTop + preview.h > window.innerHeight - pad)
      previewTop = preview.y - preview.h - off;
    previewLeft = Math.max(pad, previewLeft);
    previewTop = Math.max(pad, previewTop);
  }

  return (
    <div
      className={`group relative mb-2 break-inside-avoid cursor-pointer overflow-hidden rounded-md ring-2 transition ${
        selected ? "ring-accent" : "ring-transparent hover:ring-edge"
      }`}
      draggable={!boardOpen}
      onMouseEnter={onEnter}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={() => {
        const st = useStore.getState();
        // 创作板打开 = 挑图上下文：点瀑布流图即在光标处插入编辑器。
        if (st.boardOpen) {
          window.dispatchEvent(
            new CustomEvent("bowerbird://board-asset-picked", { detail: shown.id })
          );
        } else if (st.mode === "manage") st.toggleSelect(shown.id);
        else st.openDetail(shown.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, shown.id);
      }}
      onDragStart={(e) => {
        const st = useStore.getState();
        // manage 模式拖已选中项 = 拖全部选中（与 BatchBar 一致）；否则只拖这一张。
        const ids =
          st.mode === "manage" && st.selectedIds.has(shown.id)
            ? Array.from(st.selectedIds)
            : [shown.id];
        setDragAssets(ids);
        e.dataTransfer.effectAllowed = "move";
        // setData 必须有一次否则部分浏览器不认这次拖拽；payload 实际走模块变量（dragPayload.ts）。
        e.dataTransfer.setData("text/plain", ids.join(","));
      }}
      onDragEnd={() => setDragAssets(null)}
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
      {(shown.source === "codex" || shown.source === "jimeng") && (
        <span
          className="absolute left-1 top-1 z-10 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
          title={groupLen > 1 ? `生成图 · 同流程 ${groupLen} 张` : "生成图"}
        >
          ✨{groupLen > 1 ? ` ${idx + 1}/${groupLen}` : ""}
        </span>
      )}
      {/* 过程图轮播箭头（同流程 >1 张时悬浮显示） */}
      {groupLen > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
            disabled={idx === 0}
            className="absolute left-0 top-1/2 z-10 -translate-y-1/2 bg-black/50 px-1 text-xs text-white opacity-0 transition hover:bg-black/80 disabled:opacity-0 group-hover:opacity-100"
            title="上一张过程图"
          >
            ◀
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
            disabled={idx === groupLen - 1}
            className="absolute right-0 top-1/2 z-10 -translate-y-1/2 bg-black/50 px-1 text-xs text-white opacity-0 transition hover:bg-black/80 disabled:opacity-0 group-hover:opacity-100"
            title="下一张过程图"
          >
            ▶
          </button>
        </>
      )}
      <img
        ref={imgRef}
        className="block w-full bg-panel2"
        style={{ aspectRatio: ratio }}
        loading="lazy"
        alt={shown.name}
        draggable={false}
      />
      {colors.length > 0 && (
        <div className="flex h-2 w-full">
          {colors.map((c, i) => (
            <div key={i} className="flex-1" style={{ background: c }} />
          ))}
        </div>
      )}
      {preview &&
        previewSrc &&
        createPortal(
          <img
            src={previewSrc}
            alt=""
            draggable={false}
            className="pointer-events-none fixed z-50 rounded-md border border-edge bg-panel object-contain shadow-xl"
            style={{ left: previewLeft, top: previewTop, width: preview.w, height: preview.h }}
          />,
          document.body
        )}
    </div>
  );
}

/** 瀑布流（CSS columns masonry + 缩略图懒加载）。颜色筛选走后端（App refresh 按 colorFilter 分流），非前端过滤。 */
export function MasonryGrid() {
  const assets = useStore((s) => s.assets);
  const boardOpen = useStore((s) => s.boardOpen);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const [groupMap, setGroupMap] = useState<Record<string, Asset[]>>({});

  // 同流程生成图：批量取可见 codex 组的过程图，供缩略图轮播。无生成图时清空。
  useEffect(() => {
    const ids = assets.filter((a) => a.generation_session_id).map((a) => a.id);
    if (ids.length === 0) {
      setGroupMap({});
      return;
    }
    let alive = true;
    api
      .listGenerationGroups(ids, currentProjectId)
      .then((m) => {
        if (alive) setGroupMap(m);
      })
      .catch((e) => console.error("listGenerationGroups failed", e));
    return () => {
      alive = false;
    };
  }, [assets, currentProjectId]);

  const filtered = assets;

  if (filtered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {assets.length === 0
          ? boardOpen
            ? "还没有素材 —— 用顶部按钮导入图片，点瀑布流任意图即可插为参考图"
            : "还没有素材 —— 用顶部按钮导入图片或文件夹"
          : "当前筛选下无素材"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 滚动容器（固定高度 + 竖向滚动）与 columns 容器必须分离：
          columns 一旦有固定高度，多余内容会横向溢出开新列 → 横向滚动。
          内层 columns 不设高度，内容平分到 N 列后纵向增长，由本层竖向滚动。 */}
      <div className="h-full overflow-y-auto">
        <div className="columns-2 gap-2 p-2 md:columns-3 lg:columns-4 xl:columns-5">
          {filtered.map((a) => (
            <Thumb key={a.id} asset={a} group={groupMap[a.id]} />
          ))}
        </div>
      </div>
    </div>
  );
}
