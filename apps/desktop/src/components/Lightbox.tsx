import { useEffect } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useImageZoom } from "../lib/useImageZoom";

/**
 * 图片放大查看器（全屏遮罩）。
 * 渲染在 GenerationPanel 内部：GenerationPanel 为 absolute z-10 已高于 static 兄弟，
 * Lightbox 作为其子节点合成层仍盖住整屏（含 Toolbar/Sidebar）。
 * 关闭：点背景 / Esc / ✕；多图 ←/→ 切换。点大图本体不关闭（stopPropagation）。
 */
export function Lightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onIndexChange(Math.max(0, index - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onIndexChange(Math.min(images.length - 1, index + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, index, onClose, onIndexChange]);

  const zoom = useImageZoom(images[index]);
  const multi = images.length > 1;

  // createPortal 到 document.body：脱离 GenerationPanel 父链（多层 overflow-hidden），
  // 确保 fixed 全屏遮罩不受任何祖先层叠上下文/transform 影响，一定盖住整屏。
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览，${index + 1} / ${images.length}`}
    >
      <img
        ref={zoom.imgRef}
        src={convertFileSrc(images[index])}
        alt={`预览图 ${index + 1}`}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={zoom.onMouseDown}
        onDoubleClick={(e) => {
          e.stopPropagation();
          zoom.onDoubleClick(e);
        }}
        className="max-h-[92vh] max-w-[92vw] select-none object-contain"
        style={zoom.style}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
        title="关闭（Esc）"
      >
        <X size={18} />
      </button>
      {multi && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(Math.max(0, index - 1));
            }}
            disabled={index === 0}
            className="absolute left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 disabled:opacity-20"
            title="上一张（←）"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange(Math.min(images.length - 1, index + 1));
            }}
            disabled={index === images.length - 1}
            className="absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20 disabled:opacity-20"
            title="下一张（→）"
          >
            <ChevronRight size={22} />
          </button>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs tabular-nums text-white">
            {index + 1} / {images.length}
          </div>
        </>
      )}
    </div>,
    document.body
  );
}
