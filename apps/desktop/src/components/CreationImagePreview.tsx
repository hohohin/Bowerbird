import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Focus, MessageSquare, PanelLeft, PanelLeftClose, PanelRightClose, X, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../lib/api";
import type { Asset, GenJob } from "../lib/types";
import { useCompatibleImagePath } from "../lib/useCompatibleImagePath";
import { useImageZoom } from "../lib/useImageZoom";
import { userErrorMessage } from "../lib/userError";
import { GenerationPanel } from "./GenerationPanel";
import { AssetDetail } from "./AssetDetail";
import { useImagePreviewHud } from "./useImagePreviewHud";
import { ImagePreviewContinuation } from "./ImagePreviewContinuation";
import { imageHistoryJob } from "../lib/imagePreviewContinuation";
import { useStore } from "../store";
import "./CreationImagePreview.css";

export function CreationImagePreview({ asset, projectId, job, onClose }: {
  asset: Asset;
  projectId: string | null;
  job?: GenJob;
  onClose: () => void;
}) {
  const requestKey = `${projectId ?? ""}:${asset.id}`;
  const [history, setHistory] = useState<{ key: string; job: GenJob | null; error?: unknown } | null>(null);
  const [retry, setRetry] = useState(0);
  const [closing, setClosing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [detailsClosing, setDetailsClosing] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorClosing, setInspectorClosing] = useState(false);
  const [contentKey, setContentKey] = useState<string | null>(null);
  const [introducedKey, setIntroducedKey] = useState<string | null>(null);
  const [inspectorKey, setInspectorKey] = useState<string | null>(null);
  const [conversationKey, setConversationKey] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(false);
  const [continuationJobId, setContinuationJobId] = useState<string | null>(null);
  const liveId = continuationJobId ?? job?.id;
  const liveJob = useStore(state => liveId ? state.genJobs[liveId] : undefined);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageAnchorRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const pressedPanelRef = useRef<HTMLElement | null>(null);
  const blankPress = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const detailsTimer = useRef<ReturnType<typeof setTimeout>>();
  const inspectorTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const pointerFrame = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const originalPath = asset.store_path ?? asset.thumb_path;
  const [conversionFailed, setConversionFailed] = useState<string | null | undefined>(null);
  const path = useCompatibleImagePath(originalPath, () => setConversionFailed(originalPath));
  const zoom = useImageZoom(path, { min: 0.1, max: 16 });
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  const [loadedThumbnail, setLoadedThumbnail] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ path: string; width: number; height: number } | null>(null);
  const dimensions = asset.width && asset.height ? asset : naturalSize?.path === path ? naturalSize : null;
  const imageRatio = dimensions?.width && dimensions.height ? dimensions.width / dimensions.height : 1;
  const contentMounted = contentKey === requestKey;
  const imageAvailable = !!path && (loadedImage === path || failedImage === path)
    || !!asset.thumb_path && loadedThumbnail === asset.thumb_path || !!originalPath && conversionFailed === originalPath || !originalPath;
  const imageIntroduced = introducedKey === requestKey && imageAvailable;
  const inspectorVisible = imageIntroduced && inspectorKey === requestKey;
  useImagePreviewHud(surfaceRef, imageAnchorRef, layoutRef, hudRef);

  function lockPanels(panel: HTMLElement) {
    const surface = surfaceRef.current;
    if (!surface || surface.dataset.panelsLocked) return;
    // Both panels are portions of one plane: freezing either freezes the shared pose.
    surface.style.setProperty("--preview-panel-transform", getComputedStyle(panel).transform);
    surface.dataset.panelsLocked = "true";
  }
  function unlockPanels() {
    const surface = surfaceRef.current;
    if (!surface?.dataset.panelsLocked) return;
    const focus = document.activeElement;
    if (pressedPanelRef.current || focus instanceof Element && surface.contains(focus)
      && focus.closest('.creation-image-preview-conversation:not([aria-hidden="true"])')
      && focus.matches('input, textarea, select, [contenteditable="true"], :focus-visible')) return;
    surface.style.removeProperty("--preview-panel-transform");
    delete surface.dataset.panelsLocked;
  }
  useEffect(() => {
    const release = () => {
      pressedPanelRef.current = null;
      unlockPanels();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, []);

  useEffect(() => {
    setClosing(false);
    setDetailsOpen(true);
    setDetailsClosing(false);
    setInspectorOpen(true);
    setInspectorClosing(false);
    setContentKey(null);
    setIntroducedKey(null);
    setInspectorKey(null);
    setConversationKey(null);
    setFollowLatest(false);
    setContinuationJobId(null);
    // Let the image paint before mounting the data-heavy inspector and conversation.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setContentKey(requestKey));
    });
    const intro = setTimeout(() => setIntroducedKey(requestKey), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
    return () => {
      cancelAnimationFrame(frame); cancelAnimationFrame(pointerFrame.current); clearTimeout(intro);
      clearTimeout(closeTimer.current); clearTimeout(detailsTimer.current); clearTimeout(inspectorTimer.current); closeTimer.current = undefined;
    };
  }, [requestKey]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => surfaceRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (job || !contentMounted) return;
    let current = true;
    setHistory(null);
    void (async () => {
      try {
        let result = await api.generationHistory(asset.id, projectId);
        // Library images can belong to another project; viewing never changes that ownership.
        if (projectId && !result.turns.length && asset.generation_session_id) result = await api.generationHistory(asset.id, null);
        if (!current) return;
        const restored = result.turns.length ? imageHistoryJob(result, {
          id: `image-preview:${asset.id}`, projectId, createdAt: asset.created_at ?? 0,
        }) : null;
        setHistory({ key: requestKey, job: restored });
      } catch (reason) {
        if (current) setHistory({ key: requestKey, job: null, error: reason });
      }
    })();
    return () => { current = false; };
  }, [asset.id, asset.generation_session_id, projectId, job, requestKey, retry, contentMounted]);

  const ready = history?.key === requestKey ? history : null;
  const source = liveJob ?? job ?? ready?.job;
  const sourceJobId = liveJob?.id ?? job?.id ?? null;
  const snapshot = useMemo(() => {
    if (!source || !contentMounted) return null;
    const previewJob = { ...source, id: `image-preview:${asset.id}`, conversationId: undefined,
      turns: source.turns.map(turn => ({ ...turn, turnKey: turn.turnKey ?? `${turn.id}` })) };
    const selected = (followLatest ? previewJob.turns[previewJob.turns.length - 1] : previewJob.turns.find(turn => !!asset.store_path && turn.images.includes(asset.store_path)))
      ?? previewJob.turns[previewJob.turns.length - 1];
    return { job: previewJob, sourceJobId, selectedTurnKey: selected?.turnKey ?? "", onReuse: () => {} };
  }, [source, asset.id, asset.store_path, sourceJobId, contentMounted, followLatest]);
  const hasConversation = !!job || !!snapshot || ready?.error != null || (!ready && !!asset.generation_session_id);
  const conversationContentReady = imageIntroduced && (!!snapshot || !!ready);
  const conversationVisible = conversationContentReady && conversationKey === requestKey;
  useEffect(() => {
    if (!conversationContentReady) return;
    // The read-only conversation builds its prompt views on mount; reveal after that commit.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setConversationKey(requestKey)); });
    return () => cancelAnimationFrame(frame);
  }, [conversationContentReady, requestKey]);

  function close() {
    if (closeTimer.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { closeRef.current(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => closeRef.current(), 140);
  }
  function toggleDetails() {
    clearTimeout(detailsTimer.current);
    if (!detailsOpen || detailsClosing) { setDetailsClosing(false); setDetailsOpen(true); return; }
    detailsToggleRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setDetailsOpen(false); return; }
    setDetailsClosing(true);
    detailsTimer.current = setTimeout(() => { setDetailsOpen(false); setDetailsClosing(false); }, 120);
  }
  function toggleInspector() {
    clearTimeout(inspectorTimer.current);
    if (!inspectorOpen || inspectorClosing) { setInspectorClosing(false); setInspectorOpen(true); return; }
    inspectorToggleRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setInspectorOpen(false); return; }
    setInspectorClosing(true);
    inspectorTimer.current = setTimeout(() => { setInspectorOpen(false); setInspectorClosing(false); }, 120);
  }
  function isBlank(target: EventTarget) {
    return target instanceof Element && target.matches(".creation-image-preview, .creation-image-preview-backdrop, .creation-image-preview-layout");
  }

  return createPortal(<div ref={surfaceRef} className={`creation-image-preview canvas-tactical${closing ? " is-closing" : ""}`}
    role="dialog" aria-modal="true" aria-label="图片与会话预览"
    onPointerDownCapture={event => {
      blankPress.current = event.button === 0 && isBlank(event.target) ? { x: event.clientX, y: event.clientY, moved: false } : null;
      const panel = event.target instanceof Element && event.currentTarget.contains(event.target)
        ? event.target.closest<HTMLElement>(".creation-image-preview-conversation") : null;
      if (panel) { pressedPanelRef.current = panel; lockPanels(panel); }
    }}
    onFocusCapture={event => {
      if (!event.currentTarget.contains(event.target) || !event.target.matches('input, textarea, select, [contenteditable="true"], :focus-visible')) return;
      const panel = event.target.closest<HTMLElement>(".creation-image-preview-conversation");
      if (panel) lockPanels(panel);
    }}
    onBlurCapture={event => {
      const panel = event.target.closest<HTMLElement>(".creation-image-preview-conversation");
      if (panel) queueMicrotask(unlockPanels);
    }}
    onClick={event => {
      const press = blankPress.current;
      blankPress.current = null;
      // A drag released outside the image must not turn into a backdrop click.
      if (event.button === 0 && !event.defaultPrevented && press && !press.moved && isBlank(event.target)
        && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4) close();
    }}
    onPointerMove={event => {
      const press = blankPress.current;
      if (press && event.buttons && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 4) press.moved = true;
      // An inline editor can unmount on Escape without dispatching blur.
      unlockPanels();
      if (event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !(event.target instanceof Element)) return;
      if (!event.currentTarget.contains(event.target)) return;
      const surface = event.currentTarget, x = event.clientX, y = event.clientY;
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = requestAnimationFrame(() => {
        const bounds = surface.getBoundingClientRect();
        const px = (x - bounds.left) / bounds.width - .5, py = (y - bounds.top) / bounds.height - .5;
        surface.style.setProperty("--projection-shift-x", `${px * 8}px`);
        surface.style.setProperty("--projection-shift-y", `${py * 8}px`);
        // Project cards' layered perspective, shared by panels and the image's backing planes.
        surface.style.setProperty("--preview-tilt-x", `${-py * 3.5}deg`);
        surface.style.setProperty("--preview-tilt-y", `${px * 3.5}deg`);
      });
    }}
    onPointerLeave={event => {
      if (blankPress.current) blankPress.current.moved = true;
      cancelAnimationFrame(pointerFrame.current);
      for (const name of ["--projection-shift-x", "--projection-shift-y", "--preview-tilt-x", "--preview-tilt-y"]) event.currentTarget.style.removeProperty(name);
    }}
    onKeyDown={event => {
      // Nested media/menu portals own their keys even though React bubbles them here.
      if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node) || document.querySelector(".media-lightbox")) return;
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'))
          .filter(item => item.getClientRects().length && !item.closest('.is-leaving, [inert], [aria-hidden="true"]'));
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <div className="creation-image-preview-backdrop" aria-hidden="true"/>
    <div className="creation-image-preview-projection" aria-hidden="true"/>
    <div ref={layoutRef} className="creation-image-preview-layout">
      <section className={`creation-image-preview-conversation creation-image-preview-inspector ${!inspectorOpen ? "is-collapsed" : inspectorVisible ? "is-ready" : "is-loading"}${inspectorClosing ? " is-leaving" : ""}`}
        aria-label="图片详情" aria-hidden={!inspectorVisible || !inspectorOpen || inspectorClosing}>
        <div className="creation-image-preview-conversation-plane" aria-hidden="true"/>
        <header className="creation-image-preview-conversation-head">
          <h2>图片详情</h2>
          <button type="button" onClick={toggleInspector} aria-label="收起图片详情面板" title="收起图片详情"><PanelLeftClose size={16}/></button>
        </header>
        {contentMounted && <AssetDetail key={requestKey} panelOnly initialAsset={asset}
          onReady={() => setInspectorKey(requestKey)}
          selection={{ assetId: asset.id, onClose: close, onOpen: close, onNavigate: close }}/>}
        <span className="creation-image-preview-panel-mark" aria-hidden="true"/>
      </section>
      <section className="creation-image-preview-image" aria-label="放大图片">
        <figure className="creation-image-preview-figure" style={{ "--image-ratio": imageRatio } as CSSProperties}>
          <div ref={imageAnchorRef} className="creation-image-preview-image-anchor" style={{ ...zoom.style, cursor: zoom.dragging ? "grabbing" : "grab", "--image-scale": zoom.scale } as CSSProperties}>
            <div className="creation-image-preview-image-depth" aria-hidden="true"><i/><i/></div>
            <div className="creation-image-preview-image-viewport">
              {asset.thumb_path && asset.thumb_path !== path && loadedImage !== path && <img className="creation-image-preview-thumbnail"
                src={convertFileSrc(asset.thumb_path)} alt="" aria-hidden="true" draggable={false}
                onLoad={() => setLoadedThumbnail(asset.thumb_path!)}/>}
              {path && failedImage !== path ? <img ref={zoom.imgRef} src={convertFileSrc(path)} alt={asset.name}
                draggable={false} onMouseDown={zoom.onMouseDown}
                onDoubleClick={event => { event.stopPropagation(); zoom.onDoubleClick(event); }}
                onLoad={event => {
                  setLoadedImage(path);
                  setNaturalSize({ path, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                }}
                onError={() => setFailedImage(path)} />
                : <p role="status">{!originalPath || failedImage === path || conversionFailed === originalPath ? "图片暂时无法读取" : "正在读取图片…"}</p>}
            </div>
            <i className="creation-image-preview-image-mark start" aria-hidden="true"/>
            <i className="creation-image-preview-image-mark end" aria-hidden="true"/>
          </div>
        </figure>
      </section>
      {hasConversation && <section className={`creation-image-preview-conversation ${!detailsOpen ? "is-collapsed" : conversationVisible ? "is-ready" : "is-loading"}${detailsClosing ? " is-leaving" : ""}`}
        aria-label="独立会话面板" aria-hidden={!conversationVisible || !detailsOpen || detailsClosing}>
        <div className="creation-image-preview-conversation-plane" aria-hidden="true"/>
        <header className="creation-image-preview-conversation-head">
          <h2>会话</h2>{snapshot && <span>{snapshot.job.turns.length} 轮</span>}
          <button type="button" onClick={toggleDetails} aria-label="收起会话面板" title="收起会话"><PanelRightClose size={16}/></button>
        </header>
        <div className="creation-image-preview-history">
          {imageIntroduced && contentMounted && (snapshot ? <GenerationPanel embedded readOnly followLatest={followLatest} hydratedAssets={[asset, ...snapshot.job.refAssets]}
            snapshot={snapshot} /> : <div className="creation-image-preview-info">
          {!job && !ready ? <p role="status">正在读取对话…</p> : ready?.error != null
            ? <div className="creation-image-preview-error" role="alert"><p>{userErrorMessage(ready.error, "对话详情暂时无法读取，请重试。")}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
            : <p>暂无生成会话</p>}
          </div>)}
        </div>
        {imageIntroduced && contentMounted && source && <ImagePreviewContinuation key={requestKey}
          asset={asset} job={source} sourceJobId={sourceJobId} enabled={!closing}
          onSent={id => { setContinuationJobId(id); setFollowLatest(true); }}/>}
        <span className="creation-image-preview-panel-mark" aria-hidden="true"/>
      </section>}
    </div>
    <div ref={hudRef} className="creation-image-preview-hud">
      <header className="creation-image-preview-image-head">
        <h2>{asset.name}</h2>
        <button type="button" onClick={close} aria-label="关闭预览" title="关闭预览（Esc）"><X size={17}/></button>
      </header>
      <footer className="creation-image-preview-image-foot">
        <span>{dimensions?.width && dimensions.height ? `${dimensions.width} × ${dimensions.height}` : ""}{asset.ext && <b>{asset.ext.toUpperCase()}</b>}</span>
        <div>
          <button type="button" onClick={() => zoom.zoomBy(1 / 1.25)} disabled={zoom.scale <= 0.1} title="缩小" aria-label="缩小图片"><ZoomOut size={16}/></button>
          <output className="creation-image-preview-scale" aria-label="图片缩放比例">{Math.round(zoom.scale * 100)}%</output>
          <button type="button" onClick={() => zoom.zoomBy(1.25)} disabled={zoom.scale >= 16} title="放大" aria-label="放大图片"><ZoomIn size={16}/></button>
          <button type="button" onClick={zoom.reset} title="适应画面" aria-label="适应画面"><Focus size={16}/></button>
          {inspectorVisible && <button ref={inspectorToggleRef} type="button" onClick={toggleInspector} aria-pressed={inspectorOpen && !inspectorClosing}
            title={inspectorOpen && !inspectorClosing ? "收起图片详情" : "显示图片详情"} aria-label={inspectorOpen && !inspectorClosing ? "收起图片详情" : "显示图片详情"}><PanelLeft size={16}/></button>}
          {hasConversation && conversationVisible && <button ref={detailsToggleRef} type="button" onClick={toggleDetails} aria-pressed={detailsOpen && !detailsClosing}
            title={detailsOpen && !detailsClosing ? "收起会话" : "显示会话"} aria-label={detailsOpen && !detailsClosing ? "收起会话" : "显示会话"}><MessageSquare size={16}/></button>}
        </div>
      </footer>
    </div>
  </div>, document.body);
}
