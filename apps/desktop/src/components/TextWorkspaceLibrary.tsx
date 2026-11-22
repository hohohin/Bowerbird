import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from "react";
import { createLibraryPane, LibraryPaneContext, registerLibraryPane, libraryHasOverlay } from "../lib/libraryPane";
import { libraryShortcutSource } from "../lib/localFileMode";
import type { Asset } from "../lib/types";
import { notifyError } from "../lib/notify";
import { documentMedia } from "../lib/textDocuments";
import { isVideoAsset } from "../lib/videoGeneration";
import { useStore } from "../store";
import { AssetDetail } from "./AssetDetail";
import { AssetContextMenu } from "./AssetContextMenu";
import { CanvasFrequentAssets, useCanvasFrequentAssets } from "./CanvasFrequentAssets";
import { CanvasLibraryResize } from "./CanvasLibraryResize";
import { LibraryCatalogTransition } from "./LibraryCatalogTransition";
import { LibrarySourceTabs } from "./LibrarySourceTabs";
import "./CanvasTactical.css";
import "./IndustrialCanvas.css";
import "./LocalFileWorkspace.css";

function trapDetailTab(event: KeyboardEvent<HTMLElement>) {
  const panel = event.currentTarget;
  const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[tabindex="0"],[contenteditable="true"]')].filter(element => (element.isContentEditable || element.tabIndex >= 0) && element.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (document.activeElement === panel || document.activeElement === (event.shiftKey ? first : last)) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus();
  }
}
function detailKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if ((event.target as Element).closest('[role="dialog"], [role="menu"]') !== event.currentTarget) return;
  if (event.nativeEvent.isComposing || event.defaultPrevented) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  if (event.key === "Tab") trapDetailTab(event);
}
function WorkspaceAssetDetail(selection: NonNullable<ComponentProps<typeof AssetDetail>["selection"]>) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="text-workspace-detail" role="dialog" aria-modal="true" aria-label="素材详情" tabIndex={-1} ref={panel} onKeyDown={event => detailKeyDown(event, selection.onClose)}>
    <AssetDetail selection={selection}/>
  </div>;
}

function modified(event: MouseEvent | KeyboardEvent) { return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey; }
function cardAt(target: Element) {
  const card = target.closest<HTMLElement>('[data-asset-id]'), control = target.closest('button,input,textarea,a');
  return card && (!control || control === card) ? card : null;
}
function pickAsset(event: MouseEvent, pin: (id: string) => Promise<void>) {
  if (event.button !== 0 || event.detail > 1) return;
  const id = cardAt(event.target as Element)?.dataset.assetId;
  if (!id) return;
  event.preventDefault(); event.stopPropagation(); void pin(id);
}
function isLibraryShortcutTarget(event: KeyboardEvent) {
  const target = event.target as Element;
  return !event.defaultPrevented && !event.nativeEvent.isComposing && !modified(event)
    && !target.closest('input,textarea,select,[role="combobox"],[contenteditable="true"]')
    && target.closest('[role="dialog"], [role="menu"]') === event.currentTarget.closest('[role="dialog"]');
}
function libraryKeyDown(event: KeyboardEvent<HTMLElement>, mode: ReturnType<typeof createLibraryPane>["mode"], close: () => void) {
  if (!isLibraryShortcutTarget(event) || event.repeat || event.nativeEvent.keyCode === 229 || libraryHasOverlay(event.currentTarget)) return;
  const source = libraryShortcutSource(event.key), state = mode.getState();
  const toggleLens = event.key === "Tab" && state.source !== "folders";
  if (!source && !toggleLens && event.key !== "Escape") return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === "Escape") { close(); return; }
  if (source) state.openSource(source); else state.toggleCatalog();
  event.currentTarget.focus({ preventScroll: true });
}

function useWorkspaceLibraryPane(projectId?: string) {
  const scopeId = projectId ?? null;
  const [pane] = useState(() => createLibraryPane(`text-workspace:${scopeId ?? "global"}`));
  useEffect(() => registerLibraryPane(pane), [pane]);
  useEffect(() => pane.mode.getState().setProjectContext(scopeId), [pane, scopeId]);
  const source = pane.mode(state => state.source), media = pane.mode(state => state.media);
  return { pane, source, media, scopeId };
}

export function TextWorkspaceLibrary({ open, projectId, onInsert, onClose, onNavigate, onReusePrompt }: {
  open: boolean; projectId?: string; onInsert(asset: Asset): void; onClose(): void; onNavigate(): void; onReusePrompt(prompt: string): void;
}) {
  const { pane, source, media, scopeId } = useWorkspaceLibraryPane(projectId);
  const id = useId();
  const library = useCanvasFrequentAssets(open, scopeId);
  const [picking, setPicking] = useState(false), [detail, setDetail] = useState<string | null>(null);
  const [menu, setMenu] = useState<ReturnType<typeof useStore.getState>["contextMenu"]>(null);
  const openContextMenu: ReturnType<typeof useStore.getState>["openContextMenu"] = (x, y, assetId, context) => setMenu({ x, y, assetId, workspaceProjectId: scopeId, ...context });
  function insert(asset: Asset) {
    if (documentMedia(asset)) onInsert(asset);
    else if (isVideoAsset(asset)) notifyError(new Error("素材原文件不可用"), "无法插入视频素材");
    else setDetail(asset.id);
  }
  const closeLibrary = () => { if (picking) setPicking(false); else onClose(); };
  const navigation = <header className="library-browser-heading"><div className="library-floating-navigation">
    <LibrarySourceTabs/>
  </div></header>;
  return <LibraryPaneContext.Provider value={pane}>
    <aside id={id} className="canvas-source-panel library-browser text-workspace-library" aria-label="文本编辑器素材库" aria-hidden={!open}
      data-library-pane={pane.id} data-file-import-project-id={source === "project" ? projectId : ""}
      ref={element => { if (element) element.inert = !open; }} tabIndex={-1} onKeyDown={event => libraryKeyDown(event, pane.mode, closeLibrary)} onClickCapture={event => { if (picking) pickAsset(event, library.pinAsset); }}
      onDoubleClickCapture={event => { if (picking) { event.preventDefault(); event.stopPropagation(); } }}>
      <div className="canvas-source-content"><LibraryCatalogTransition key={scopeId}
        media={media} projectId={scopeId} navigation={navigation} onClose={onClose} onNavigate={onNavigate}
        onInsertAsset={insert} onOpenAsset={asset => setDetail(asset.id)} onAssetContextMenu={openContextMenu}/></div>
      <CanvasFrequentAssets library={library} projectId={scopeId} picking={picking} onPickingChange={setPicking} onInsertAsset={insert} onOpenAsset={asset => setDetail(asset.id)} onAssetContextMenu={openContextMenu}/>
    </aside>
    <CanvasLibraryResize panelId={id} collapsed={!open} onClose={onClose} onEscape={closeLibrary} reserveWidth={360} initialWidth={600} storageKey="bowerbird.textWorkspaceLibraryWidth"/>
    {detail && <WorkspaceAssetDetail assetId={detail} onClose={() => setDetail(null)} onOpen={setDetail} onContextMenu={openContextMenu} onNavigate={onNavigate}/>}
    <AssetContextMenu selection={{ menu, onClose: () => setMenu(null), onOpen: setDetail, detailAssetId: detail, onNavigate, onReusePrompt }}/>
  </LibraryPaneContext.Provider>;
}
