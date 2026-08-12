import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
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

/** 读 File 为 data URL（拖拽 / 粘贴入库用，传后端 base64 解码）。 */
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
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
  // 有反推（caption）→ 左上角 🏷️ 标记（生成图同时在标时，🏷️ 排在 ✨ 右侧）。
  const hasCaption = useStore((s) => s.captionedIds.has(shown.id));

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
  const [hovering, setHovering] = useState(false);
  // 滚轮滚走后放大图卡住的根因：滚动把缩略图元素移走而指针静止时，浏览器不分派
  // mouseleave，onLeave 不触发 → 放大图一直挂到指针重新进出该图才消失。整个 hover
  // 生命周期（定时器等待期 + 放大图弹出期）监听 scroll，一旦滚动立刻清定时器 + 收回。
  // 捕获阶段 + window：scroll 不冒泡，但捕获期能收到内部 overflow-y-auto 容器的滚动。
  useEffect(() => {
    if (!hovering) return;
    function onScroll() {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      setPreview(null);
    }
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [hovering]);
  function onEnter(e: MouseEvent<HTMLDivElement>) {
    if (!previewSrc) return;
    mouseRef.current = { x: e.clientX, y: e.clientY };
    setHovering(true);
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
    setHovering(false);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
  }
  // 弹出面板（右键菜单/放大预览 portal 到 body）出现时同步收回预览——预览 z-30 低于面板
  // z-40/z-50，但不收会被它盖住的是面板下方的交互；点图/拖拽/右键本身也应立刻收回。
  function dismissPreview() {
    setHovering(false);
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
        dismissPreview();
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
        dismissPreview();
        openContextMenu(e.clientX, e.clientY, shown.id);
      }}
      onDragStart={(e) => {
        dismissPreview();
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
      {(shown.source === "codex" || shown.source === "jimeng" || shown.source === "bowerbird-cloud" || hasCaption) && (
        <div className="absolute left-1 top-1 z-10 flex items-center gap-1">
          {(shown.source === "codex" || shown.source === "jimeng" || shown.source === "bowerbird-cloud") && (
            <span
              className="rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
              title={groupLen > 1 ? `生成图 · 同流程 ${groupLen} 张` : "生成图"}
            >
              ✨{groupLen > 1 ? ` ${idx + 1}/${groupLen}` : ""}
            </span>
          )}
          {hasCaption && (
            <span
              className="rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
              title="已反推（有提示词描述）"
            >
              🏷️
            </span>
          )}
        </div>
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
            className="pointer-events-none fixed z-30 rounded-md border border-edge bg-panel object-contain shadow-xl"
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
  // 拖拽外部图片入库（仅瀑布流区域）：HTML5 DnD，dragDropEnabled=false 保持内部拖拽到侧栏。
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);

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

  // 拖入外部图片文件 → dataURL → importImageBytes（source=imported，进当前 project scope）。
  // 串行导入（失败隔离）：单张失败不中断后续，错误打控制台。
  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length === 0) return;
    setImporting(true);
    try {
      for (const f of files) {
        try {
          const dataUrl = await readFileAsDataURL(f);
          await api.importImageBytes({
            dataUrl,
            fileName: f.name,
            projectId: currentProjectId,
            source: "imported",
          });
        } catch (err) {
          console.error("drop import failed", f.name, err);
        }
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        // 仅响应外部文件拖入（含 "Files"）；preventDefault 才能触发 drop。
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // relatedTarget 不在容器内 = 真离开，清遮罩（防子元素进出抖动）。
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={handleDrop}
    >
      {filtered.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted">
          {assets.length === 0
            ? boardOpen
              ? "还没有素材 —— 用顶部按钮导入图片，点瀑布流任意图即可插为参考图"
              : "还没有素材 —— 用顶部按钮导入图片或文件夹，或直接拖图进来 / 截图后 Ctrl+V"
            : "当前筛选下无素材"}
        </div>
      ) : (
        <div className="h-full overflow-y-auto">
          {/* 滚动容器（固定高度 + 竖向滚动）与 columns 容器必须分离：
              columns 一旦有固定高度，多余内容会横向溢出开新列 → 横向滚动。
              内层 columns 不设高度，内容平分到 N 列后纵向增长，由本层竖向滚动。 */}
          <div className="columns-2 gap-2 p-2 md:columns-3 lg:columns-4 xl:columns-5">
            {filtered.map((a) => (
              <Thumb key={a.id} asset={a} group={groupMap[a.id]} />
            ))}
          </div>
        </div>
      )}

      {/* 拖拽遮罩：拖文件进入瀑布流时提示「松开导入」。 */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-accent/10 ring-2 ring-inset ring-accent">
          <div className="rounded-lg bg-panel/95 px-4 py-2 text-sm font-medium text-accent shadow-lg">
            松开导入{currentProjectId ? "到当前项目" : "到素材库"}
          </div>
        </div>
      )}
      {importing && !dragOver && (
        <div className="pointer-events-none absolute right-2 top-2 z-30 rounded bg-panel/95 px-2 py-1 text-xs text-muted shadow">
          导入中…
        </div>
      )}
    </div>
  );
}
