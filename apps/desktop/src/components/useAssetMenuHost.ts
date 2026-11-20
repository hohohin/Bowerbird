import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { CANVAS_ARTBOARD_FROM_IMAGE } from "../lib/canvasArtboard";
import { OPEN_LOCAL_FILES } from "../lib/externalFiles";
import { requestPinterestSearch } from "../lib/pinterestSearch";

export type AssetMenuContext = NonNullable<ReturnType<typeof useStore.getState>["contextMenu"]>;

export type AssetMenuHostSelection = {
  menu: AssetMenuContext | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  detailAssetId: string | null;
  onNavigate?: () => void;
  onReusePrompt?: (prompt: string) => void;
};

export function useAssetMenuHost(selection?: AssetMenuHostSelection) {
  const embedded = !!selection;
  const globalMenu = useStore(state => embedded ? null : state.contextMenu);
  const globalDetail = useStore(state => embedded ? null : state.detailAssetId);
  const menu = selection ? selection.menu : globalMenu;
  const currentMenu = useRef(menu);
  currentMenu.current = menu;
  useEffect(() => () => { currentMenu.current = null; }, []);

  const isCurrent = () => (embedded ? currentMenu.current : useStore.getState().contextMenu) === menu;
  const close = () => {
    if (!isCurrent()) return;
    if (selection) selection.onClose();
    else useStore.getState().closeContextMenu();
  };
  const navigate = () => selection?.onNavigate?.();

  return {
    menu,
    embedded,
    detailAssetId: selection ? selection.detailAssetId : globalDetail,
    isCurrent,
    close,
    navigate,
    reusePrompt: selection?.onReusePrompt,
    selectionComplete: embedded ? undefined : () => useStore.getState().exitManage(),
    openDetail(target: AssetMenuContext) {
      close();
      if (selection) selection.onOpen(target.assetId);
      else {
        if (target.fileSelection) useStore.setState({ mode: "browse" });
        useStore.getState().openDetail(target.assetId);
      }
    },
    select(target: AssetMenuContext) {
      if (target.fileSelection) target.fileSelection.select();
      else {
        const store = useStore.getState();
        if (store.mode !== "manage") store.enterManage();
        store.toggleSelect(target.assetId);
      }
      close();
    },
    searchPinterest(assetId: string) {
      close();
      navigate();
      requestPinterestSearch(assetId);
    },
    openReferences(target: AssetMenuContext) {
      close();
      if (target.fileSelection) target.fileSelection.openReferences();
      else {
        navigate();
        window.dispatchEvent(new Event(OPEN_LOCAL_FILES));
      }
    },
    peek(target: AssetMenuContext) {
      const nodeId = target.canvasSelection?.nodeIds[0];
      const anchor = nodeId ? document.querySelector<HTMLElement>(`[data-canvas-node-id="${CSS.escape(nodeId)}"]`) : null;
      close();
      window.dispatchEvent(new CustomEvent("bowerbird://board-asset-peek", {
        detail: { assetId: target.assetId, anchor, point: { x: target.x, y: target.y } },
      }));
    },
    createArtboard(target: AssetMenuContext) {
      window.dispatchEvent(new CustomEvent(CANVAS_ARTBOARD_FROM_IMAGE, {
        detail: { ...target.canvasSelection, assetId: target.assetId },
      }));
      close();
    },
  };
}
