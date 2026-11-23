import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Asset } from "../lib/types";
import { setDragAssets } from "../lib/dragPayload";
import { FileMediaCard } from "./FileMediaCard";
import { GenerationGroupControls } from "./GenerationGroupControls";
import { Copy } from "lucide-react";

export function LibraryReferenceBadge() {
  return <span className="library-reference-badge"><Copy size={12} aria-hidden="true"/>分身</span>;
}

export function CatalogAssetCard({ asset, group, style, ratio, selected, revision, onSelect, onActivate, onOpen, onContextMenu, onBrowseGroup, projectSection, itemKey = asset => asset.id, renderMedia }: {
  itemKey?: (asset: Asset) => string; renderMedia?: (asset: Asset, style: CSSProperties, ratio: number) => ReactNode;
  asset: Asset; group?: Asset[]; style: CSSProperties; ratio: number; selected: Set<string>; revision: number;
  onSelect: (asset: Asset, additive: boolean, range: boolean) => void; onActivate?: (asset: Asset) => void;
  onOpen: (asset: Asset) => void; onContextMenu: (asset: Asset, x: number, y: number) => void;
  onBrowseGroup?: (head: string, shown: string | null) => void;
  projectSection?: string;
}) {
  const images = group?.length ? group : [asset];
  const newest = itemKey(images[images.length - 1]);
  const [selection, setSelection] = useState<{ newest: string; selected: string }>();
  const savedIndex = selection?.newest === newest ? images.findIndex(image => itemKey(image) === selection.selected) : -1;
  const index = savedIndex >= 0 ? savedIndex : images.length - 1;
  const shown = images[index];
  const grouped = images.length > 1;
  const headKey = itemKey(asset), shownKey = itemKey(shown);
  useEffect(() => {
    if (!grouped) return;
    const key = projectSection ? `${projectSection}:${headKey}` : headKey;
    onBrowseGroup?.(key, shownKey);
    return () => onBrowseGroup?.(key, null);
  }, [headKey, shownKey, grouped, projectSection, onBrowseGroup]);
  const reference = shown.id === asset.id ? asset : shown;
  const badge = !!projectSection && (reference.is_reference || (reference.project_count ?? 0) > 1);
  const mediaStyle = grouped || badge ? { width: "100%", height: "100%" } : style;
  const card = renderMedia ? renderMedia(shown, mediaStyle, ratio) : <FileMediaCard style={mediaStyle}
    entry={{ path: shown.store_path ?? "", name: shown.name, directory: false, preview: shown.thumb_path, version: `${shown.id}:${shown.file_mtime ?? 0}:${shown.thumb_path && shown.thumb_path !== shown.store_path ? shown.thumb_path : revision}` }}
    aspectRatio={ratio} selected={selected.has(shown.id)} revision={revision} labels={[]} assetId={shown.id} generated={!!group?.length || shown.generation_session_id != null || shown.source === "comfy-h3"} duration={shown.duration}
    onSelect={(additive, range) => onSelect(shown, additive, range)}
    onActivate={onActivate ? () => onActivate(shown) : undefined} onOpen={() => onOpen(shown)} onContextMenu={(x, y) => onContextMenu(shown, x, y)}
    dragAssetIds={() => selected.has(shown.id) ? [...selected] : [shown.id]} onDragEnd={() => setDragAssets(null)}/>;
  return grouped || badge ? <div className={grouped ? "generation-group catalog-generation-group" : "catalog-positioned-card"} data-generation-group={grouped ? asset.id : undefined} style={style}>
    {card}{badge && <LibraryReferenceBadge/>}{grouped && <GenerationGroupControls index={index} count={images.length} onSelect={index => setSelection({ newest, selected: itemKey(images[index]) })}/>}
  </div> : card;
}
