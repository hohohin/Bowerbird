import { useEffect, useRef, useState, type DragEvent } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { getDragAssets, setDragAssets } from "../lib/dragPayload";
import { DRAFT_MAX_LAYERS } from "../lib/draftDocument";
import { createLibraryPane, LibraryPaneContext } from "../lib/libraryPane";
import type { Asset } from "../lib/types";
import { LibraryCatalog } from "./LibraryCatalog";
import "./LocalFileWorkspace.css";
import "./DraftLibrary.css";

type Props = {
  projectId: string | null;
  disabled: boolean;
  onImportFiles: (files: File[]) => Promise<void>;
  onError: (error: unknown) => void;
};
const typing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable=true],[data-draft-color-panel]");

/** Reuse the library browser while owning its destination and keyboard scope. */
export function useDraftLibrary({ projectId, disabled, onImportFiles, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pane] = useState(() => createLibraryPane("draft-picker"));
  const panelRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const importLock = useRef(false);
  const dragging = useRef(false);
  const mounted = useRef(true);
  const frame = useRef(0);
  function hide() {
    setOpen(false);
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  }
  function toggle() {
    if (disabled || importLock.current) return;
    if (open) { hide(); return; }
    const mode = pane.mode.getState();
    if (mode.contextProjectId !== projectId) {
      mode.setProjectContext(projectId);
      mode.selectHierarchy({ kind: "all" });
    }
    pane.mode.setState({ query: "", generatedFilter: null });
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInitialized(true); setOpen(true);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
  }
  useEffect(() => {
    mounted.current = true;
    const finishDrag = () => {
      if (!dragging.current) return;
      dragging.current = false;
    };
    window.addEventListener("dragend", finishDrag);
    window.addEventListener("drop", finishDrag);
    window.addEventListener("blur", finishDrag);
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame.current);
      window.removeEventListener("dragend", finishDrag);
      window.removeEventListener("drop", finishDrag);
      window.removeEventListener("blur", finishDrag);
      if (dragging.current) setDragAssets(null);
    };
  }, []);

  async function importIds(ids: string[]) {
    if (disabled || importLock.current || !ids.length) return;
    importLock.current = true; setImporting(true);
    hide();
    try {
      const unique = [...new Set(ids)];
      if (unique.length > DRAFT_MAX_LAYERS) throw new Error("一次最多添加 32 张图片，请减少所选素材");
      // Resolve trusted asset records: never accept a path from drag text or MIME data.
      const assets = await api.getAssetsByIds(unique);
      const files: File[] = [];
      for (const id of unique) {
        const asset = assets.find(asset => asset.id === id);
        if (!asset?.store_path) throw new Error("部分素材原文件已不可用，请重新选择");
        if (/^(mp4|mov|webm|m4v|avi|mkv)$/i.test(asset.ext || "")) throw new Error("草稿只能添加图片素材");
        const data = await api.readImageDataUrl(asset.store_path);
        if (!data.startsWith("data:image/")) throw new Error("素材不是可读取的图片");
        const blob = await (await fetch(data)).blob();
        if (blob.size > 30 * 1024 * 1024) throw new Error("请选择 30 MB 以内的图片");
        files.push(new File([blob], asset.name || "素材图片", { type: blob.type }));
      }
      if (mounted.current) await onImportFiles(files);
    } catch (error) { if (mounted.current) onError(error); }
    finally { importLock.current = false; if (mounted.current) setImporting(false); }
  }
  function handleDrop(event: DragEvent): boolean {
    const ids = getDragAssets();
    if (!ids?.length) return false;
    event.preventDefault(); event.stopPropagation();
    setDragAssets(null);
    if (!disabled && !importLock.current) void importIds([...ids]);
    return true;
  }
  function handleKeyDown(event: KeyboardEvent): boolean {
    if (importLock.current) {
      if (event.key !== "Tab" && !typing(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
      return true;
    }
    if (event.isComposing || event.keyCode === 229) return open;
    const nested = event.target instanceof Element ? event.target.closest('[role="dialog"], [role="menu"]') : null;
    if (nested && !nested.classList.contains("draft-editor")) return open;
    const plainTab = event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(event.target);
    if (plainTab) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat && !disabled) toggle();
      return true;
    }
    if (!open) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); hide(); }
    // Keep ordinary typing, focus traversal and library shortcuts native, but do
    // not let the editor interpret them as tools, deletion or document saves.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopImmediatePropagation(); }
    return true;
  }
  const panel = initialized ? <aside ref={element => { panelRef.current = element; if (element) element.inert = !open || disabled || importing; }}
    className={`draft-library library-browser${open ? " is-open" : ""}`} data-draft-library aria-label="草稿素材库" aria-hidden={!open} tabIndex={-1}
    onPointerDown={event => event.stopPropagation()} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); }}
    onDragStart={event => {
      if (disabled || importLock.current) { event.preventDefault(); return; }
      if (!(event.target as HTMLElement).closest("[data-asset-id]") || !getDragAssets()?.length) return;
      dragging.current = true;
      cancelAnimationFrame(frame.current);
      // Keep the source mounted and its filter unchanged until dragend/drop.
      frame.current = requestAnimationFrame(() => { if (dragging.current) setOpen(false); });
    }}>
    <div className="draft-library-heading"><strong>素材库</strong><span>拖入画布或双击添加图层</span>
      <button type="button" aria-label="关闭草稿素材库" onClick={hide}><X size={16}/></button></div>
    <div className="draft-library-content"><LibraryPaneContext.Provider value={pane}>
      <LibraryCatalog media="images" projectId={projectId} positionId={pane.id} onClose={hide}
        onPickImages={(assets: Asset[]) => importIds(assets.map(asset => asset.id))}/>
    </LibraryPaneContext.Provider></div>
    <p className="draft-library-hint">Tab 收起素材库 · Esc 返回编辑器</p>
  </aside> : null;
  return { panel, open, importing, toggle, handleDrop, handleKeyDown };
}
