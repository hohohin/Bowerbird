import type { KeyboardEvent, RefObject } from "react";
import { useStore } from "../store";
import { creationImageAssetId, useCreationImageInteraction } from "./useCreationImageInteraction";

function resolveHomeImage(media: HTMLElement) {
  const state = useStore.getState();
  if (!media.closest(".library-home") || state.mode === "manage" || state.collectionAddTargetId) return null;
  const assetId = creationImageAssetId(media);
  if (!assetId) return null;
  return { assetId, asset: state.assets.find(asset => asset.id === assetId) ?? state.promptedAssets.find(asset => asset.id === assetId) };
}

function focusLibrary(root: RefObject<HTMLElement>) {
  const pane = root.current?.querySelector<HTMLElement>('.library-pane-content[data-active="true"]')
    ?? root.current?.querySelector<HTMLElement>(".library-pane-content");
  pane?.focus({ preventScroll: true });
}

function modifiedTab(event: KeyboardEvent<HTMLDivElement>) {
  return event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented || event.nativeEvent.isComposing;
}

function availableLibrary(target: Element) {
  const state = useStore.getState();
  return !state.projectRoutePending && !state.contextMenu && !state.projectContextMenu
    && !target.closest("[inert]") && !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
}

function composerLibraryTab(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab" || modifiedTab(event)) return false;
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target) || !target.closest(".creation-editor .ProseMirror")) return false;
  return availableLibrary(target);
}

/** The visible catalog supplies identity; the shared gesture loads authoritative assets on cache misses. */
export function useHomeCreationImage(root: RefObject<HTMLElement>, enabled: boolean) {
  const image = useCreationImageInteraction({ root, enabled, scope: "home", resolve: resolveHomeImage });
  const openLibrary = () => focusLibrary(root);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (image.gesture.keyDown(event)) return;
    if (!enabled || !composerLibraryTab(event)) return;
    event.preventDefault(); event.stopPropagation(); openLibrary();
  };
  return { ...image, openLibrary, keyDown };
}
