import { useEffect, useState, type CSSProperties } from "react";
import type { Asset } from "../lib/types";
import { setDragAssets } from "../lib/dragPayload";
import { FileMediaCard } from "./FileMediaCard";
import { GenerationGroupControls } from "./GenerationGroupControls";

export function CatalogAssetCard({ asset, group, style, ratio, selected, revision, onSelect, onActivate, onOpen, onContextMenu, onBrowseGroup }: {
  asset: Asset; group?: Asset[]; style: CSSProperties; ratio: number; selected: Set<string>; revision: number;
  onSelect: (asset: Asset, additive: boolean, range: boolean) => void; onActivate?: (asset: Asset) => void;
  onOpen: (asset: Asset) => void; onContextMenu: (asset: Asset, x: number, y: number) => void;
  onBrowseGroup?: (head: string, shown: string | null) => void;
}) {
  const images = group?.length ? group : [asset];
  const newest = images[images.length - 1].id;
  const [selection, setSelection] = useState<{ newest: string; selected: string }>();
  const savedIndex = selection?.newest === newest ? images.findIndex(image => image.id === selection.selected) : -1;
  const index = savedIndex >= 0 ? savedIndex : images.length - 1;
  const shown = images[index];
  const grouped = images.length > 1;
  useEffect(() => {
    if (!grouped) return;
    onBrowseGroup?.(asset.id, shown.id);
    return () => onBrowseGroup?.(asset.id, null);
  }, [asset.id, shown.id, grouped, onBrowseGroup]);
  const card = <FileMediaCard style={grouped ? { width: "100%", height: "100%" } : style}
    entry={{ path: shown.store_path ?? "", name: shown.name, directory: false, preview: shown.thumb_path, version: `${shown.id}:${shown.file_mtime ?? 0}:${shown.thumb_path && shown.thumb_path !== shown.store_path ? shown.thumb_path : revision}` }}
    aspectRatio={ratio} selected={selected.has(shown.id)} revision={revision} labels={[]} assetId={shown.id} generated={shown.generation_session_id != null} duration={shown.duration}
    onSelect={(additive, range) => onSelect(shown, additive, range)}
    onActivate={onActivate ? () => onActivate(shown) : undefined} onOpen={() => onOpen(shown)} onContextMenu={(x, y) => onContextMenu(shown, x, y)}
    dragAssetIds={() => selected.has(shown.id) ? [...selected] : [shown.id]} onDragEnd={() => setDragAssets(null)}/>;
  return grouped ? <div className="generation-group catalog-generation-group" data-generation-group={asset.id} style={style}>
    {card}<GenerationGroupControls index={index} count={images.length} onSelect={index => setSelection({ newest, selected: images[index].id })}/>
  </div> : card;
}
