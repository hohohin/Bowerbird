import { type CSSProperties, useState } from "react";
import { Grid2X2, LayoutGrid } from "lucide-react";
import { useLibraryThumbnail } from "../lib/libraryPane";
import { thumbnailWidthFromZoom, thumbnailZoomFromWidth, type ThumbnailScope } from "../lib/thumbnailSize";

export function ThumbnailSizeSlider({ scope, appearance }: { scope: ThumbnailScope; appearance?: "project-manager" }) {
  const { width: value, setWidth } = useLibraryThumbnail(scope);
  const zoom = thumbnailZoomFromWidth(value, scope);
  const [draft, setDraft] = useState<string | null>(null);
  const label = scope === "library" ? "主页素材大小" : scope === "projects" ? "项目卡片大小" : "项目素材大小";
  function commit() {
    if (draft !== null && draft.trim() && Number.isFinite(Number(draft))) setWidth(thumbnailWidthFromZoom(Number(draft), scope));
    setDraft(null);
  }
  if (appearance === "project-manager") return <div className="project-manager-size" role="group" aria-label={label} title={label}
    onKeyDown={event => event.stopPropagation()}>
    <LayoutGrid size={18} aria-hidden="true"/>
    <input type="range" min={0} max={100} step={1} value={zoom} aria-label={label} aria-valuetext={`卡片大小 ${zoom}（0–100）`}
      style={{ "--size-fill": `${zoom}%` } as CSSProperties}
      onChange={event => setWidth(thumbnailWidthFromZoom(Number(event.target.value), scope))}/>
    <Grid2X2 size={19} aria-hidden="true"/>
  </div>;
  return <div className="thumbnail-size-slider is-floating" role="group" aria-label="素材缩略图大小调整"
    title="素材缩略图大小调整" onKeyDown={event => event.stopPropagation()}>
    <svg className="thumbnail-size-icon" viewBox="0 0 22 12" aria-hidden="true">
      <rect x="0" y="7" width="3" height="3" rx=".5" />
      <rect x="6" y="5" width="5" height="5" rx=".5" />
      <rect x="14" y="2" width="8" height="8" rx=".5" />
    </svg>
    <div className="thumbnail-size-track">
      <svg className="thumbnail-size-ticks" viewBox="0 0 120 20" preserveAspectRatio="none" aria-hidden="true">
        <path d="M6 2v3 M33 2v3 M60 2v3 M87 2v3 M114 2v3 M6 15v3 M33 15v3 M60 15v3 M87 15v3 M114 15v3" />
      </svg>
      <input type="range" min={0} max={100} step={1} value={zoom}
        aria-label={label} aria-valuetext={`素材大小 ${zoom}（0–100）`}
        onChange={event => setWidth(thumbnailWidthFromZoom(Number(event.target.value), scope))} />
    </div>
    <input className="thumbnail-size-value" type="number" inputMode="numeric"
      min={0} max={100} step={1} value={draft ?? zoom}
      aria-label={`${label}数值`} title="素材大小（0–100）"
      onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)}
      onBlur={commit} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
      }} />
  </div>;
}
