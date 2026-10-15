import { Minus, Plus } from "lucide-react";
import { useStore } from "../store";
import { MAX_THUMBNAIL_WIDTH, MIN_THUMBNAIL_WIDTH, type ThumbnailScope } from "../lib/thumbnailSize";

export function ThumbnailSizeSlider({ scope }: { scope: ThumbnailScope }) {
  const value = useStore(s => scope === "library" ? s.libraryThumbnailWidth : s.canvasThumbnailWidth);
  const setWidth = useStore(s => s.setThumbnailWidth);
  return <label className="thumbnail-size-slider" title={`素材目标宽度 ${value}px，实际宽度随可用空间调整`}>
    <Minus size={12} aria-hidden="true" />
    <input type="range" min={MIN_THUMBNAIL_WIDTH} max={MAX_THUMBNAIL_WIDTH} step={8} value={value}
      aria-label={scope === "library" ? "主页素材大小" : "项目素材大小"}
      aria-valuetext={`目标宽度 ${value} 像素`}
      onChange={event => setWidth(scope, Number(event.target.value))} />
    <Plus size={12} aria-hidden="true" />
  </label>;
}
