import { useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type KeyboardEvent, type RefObject } from "react";
import { api } from "../lib/api";
import { externalFiles } from "../lib/externalFiles";
import { isAudioPath } from "../lib/audioMedia";
import { isTextPath } from "../lib/textMedia";
import { isVideoPath } from "../lib/videoGeneration";
import { notifyError } from "../lib/notify";
import type { Asset } from "../lib/types";
import { useStore } from "../store";
import { BOARD_ASSET_PICK_EVENT } from "./creation/useCreationEditor";

export interface CreationImageTarget {
  assetId: string;
  asset?: Asset;
  canvasNodeId?: string;
  suppressClick?: boolean;
}

interface Options {
  root: RefObject<HTMLElement>;
  enabled: boolean;
  scope: string;
  resolve: (media: HTMLElement) => CreationImageTarget | null;
  onCapture?: () => void;
  onCanvasVideoPreview?: (path: string, media: HTMLElement) => boolean;
}

interface PreviewRequest { sequence: number; route: number; projectId: string | null; scope: string }

export function creationImageAssetId(media: HTMLElement) {
  return media.dataset.conversationImage ?? media.dataset.assetId ?? media.dataset.frequentAssetId;
}

function imageElement(root: HTMLElement | null, target: EventTarget | null, double: boolean) {
  if (!(target instanceof Element) || !root?.contains(target)) return null;
  const media = target.closest<HTMLElement>('[data-conversation-image],[data-asset-id],[data-frequent-asset-id],[data-creation-conversation]');
  if (!media || unavailableImage(media, double)) return null;
  const control = target.closest('button,input,textarea,select,a,[contenteditable="true"],[role="combobox"]');
  return control && control !== media ? null : media;
}

function unavailableImage(media: HTMLElement, double: boolean) {
  return double && media.hasAttribute("data-creation-conversation")
    || media.closest('[data-creation-pick-disabled="true"],[inert],[aria-hidden="true"],[aria-disabled="true"]')
    || media.matches(":disabled") || media.closest(".connected-media")?.querySelector(".connected-missing");
}

function mediaPath(target: CreationImageTarget, media: HTMLElement) {
  return target.asset
    ? target.asset.store_path || (target.asset.ext ? `asset.${target.asset.ext}` : target.asset.name)
    : media.dataset.filePath;
}

function modified(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
}

class ImageGesture {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private press: { x: number; y: number; moved: boolean } | null = null;
  constructor(public options: Options, private show: (asset: Asset | null) => void) {
    this.cancel = this.cancel.bind(this);
    this.close = this.close.bind(this);
    this.click = this.click.bind(this);
    this.pointerDown = this.pointerDown.bind(this);
    this.pointerMove = this.pointerMove.bind(this);
    this.keyDown = this.keyDown.bind(this);
  }

  cancel() { clearTimeout(this.timer); this.sequence++; }
  close() { this.cancel(); this.show(null); }

  private target(target: EventTarget | null, double = false) {
    const state = useStore.getState();
    if (!this.options.enabled || state.projectRoutePending) return null;
    const media = imageElement(this.options.root.current, target, double);
    // Outside creation, conversation titles keep their editing entry; images share the HUD.
    if (media?.hasAttribute("data-creation-conversation") && !(state.boardOpen || state.genEditing)) return null;
    const image = media && this.options.resolve(media);
    if (!image || !media) return null;
    const path = mediaPath(image, media);
    if (!path || isAudioPath(path) || isTextPath(path)) return null;
    const video = isVideoPath(path);
    if (video && (!state.boardOpen || state.genEditing || !this.options.root.current?.querySelector('.creation-dock.is-creating[data-video-references="true"]'))) return null;
    return { ...image, media, video };
  }

  handlesVideo(target: EventTarget | null) { return this.target(target)?.video === true; }

  private request(): PreviewRequest {
    const state = useStore.getState();
    return { sequence: this.sequence, route: state.projectRouteRevision, projectId: state.activeProjectId, scope: this.options.scope };
  }

  private current(request: PreviewRequest, image: CreationImageTarget & { media: HTMLElement }) {
    const state = useStore.getState();
    return request.sequence === this.sequence && request.scope === this.options.scope
      && request.route === state.projectRouteRevision && request.projectId === state.activeProjectId
      && this.target(image.media)?.assetId === image.assetId;
  }

  private async preview(image: CreationImageTarget & { media: HTMLElement }, request = this.request()) {
    try {
      if (!this.current(request, image)) return;
      const asset = image.asset ?? (await api.getAssetsByIds([image.assetId]))[0];
      if (!this.current(request, image)) return;
      if (!asset) throw new Error("素材已移除，无法预览");
      const path = mediaPath({ assetId: asset.id, asset }, image.media);
      if (!path || isAudioPath(path) || isTextPath(path)) return;
      if (isVideoPath(path)) {
        if (!this.handlesVideo(image.media) || this.options.onCanvasVideoPreview?.(path, image.media)) return;
        const playable = await externalFiles.media(path);
        if (this.current(request, image)) this.show({ ...asset, store_path: playable });
        return;
      }
      this.show(asset);
    } catch (error) {
      if (this.current(request, image)) notifyError(error, "无法预览素材，请重试");
    }
  }

  private reference(image: CreationImageTarget & { video?: boolean }) {
    window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, {
      detail: image.video ? { assetId: image.assetId, canvasNodeId: image.canvasNodeId, target: "creation-board" }
        : image.canvasNodeId ? { assetId: image.assetId, canvasNodeId: image.canvasNodeId } : image.assetId,
    }));
  }

  private activate(image: CreationImageTarget & { media: HTMLElement }, double: boolean, detail: number) {
    const state = useStore.getState();
    // Browsing has no double-click reference action, so the image can open immediately.
    if (!(state.boardOpen || state.genEditing)) { if (!double) void this.preview(image); return; }
    if (double) this.reference(image);
    else if (detail === 0) void this.preview(image);
    else if (detail === 1) {
      const request = this.request();
      this.timer = setTimeout(() => { void this.preview(image, request); }, 500);
    }
  }

  click(event: MouseEvent<HTMLDivElement>, double = false) {
    if (event.button !== 0 || modified(event)) return;
    const image = this.target(event.target, double);
    if (!image) return;
    event.preventDefault(); event.stopPropagation();
    this.cancel(); this.options.onCapture?.();
    if (event.detail !== 0 && (this.press?.moved || image.suppressClick)) return;
    this.activate(image, double, event.detail);
  }

  pointerDown(event: PointerEvent<HTMLDivElement>) {
    this.cancel();
    this.press = { x: event.clientX, y: event.clientY, moved: false };
  }
  pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (this.press && event.buttons && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >= 4) this.press.moved = true;
  }
  keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") this.cancel();
    if (event.key !== "Enter" || modified(event) || event.nativeEvent.isComposing) return false;
    const image = this.target(event.target);
    if (!image) return false;
    event.preventDefault(); event.stopPropagation(); this.cancel();
    void this.preview(image);
    return true;
  }
}

/** One gesture policy for canvas images and every library catalog; hosts only resolve ownership. */
export function useCreationImageInteraction(options: Options) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const jobs = useStore(state => state.genJobs);
  const boardOpen = useStore(state => state.boardOpen);
  const genEditing = useStore(state => state.genEditing);
  const route = useStore(state => state.projectRouteRevision);
  const controller = useRef<ImageGesture>();
  controller.current ??= new ImageGesture(options, setAsset);
  const gesture = controller.current;
  gesture.options = options;
  useLayoutEffect(() => {
    gesture.close();
    return gesture.cancel;
  }, [gesture, options.enabled, options.scope, boardOpen, genEditing, route]);
  const job = asset && Object.values(jobs).find(item => item.turns.some(turn => !!asset.store_path && turn.images.includes(asset.store_path)));
  return { gesture, preview: asset ? { asset, job: job || undefined } : null };
}
