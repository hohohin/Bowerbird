import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, Focus, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, X, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../lib/api";
import type { Asset, GenJob } from "../lib/types";
import { useCompatibleImagePath } from "../lib/useCompatibleImagePath";
import { useImageZoom } from "../lib/useImageZoom";
import { userErrorMessage } from "../lib/userError";
import { imageProviderLabel } from "../lib/genProviders";
import { useVideoTranscriptPrice } from "../lib/videoTranscript";
import { videoModelLabel } from "../lib/videoGeneration";
import type { VideoTrimRequest } from "../lib/videoTrim";
import { GenerationPanel } from "./GenerationPanel";
import { AssetDetail } from "./AssetDetail";
import { useImagePreviewHud } from "./useImagePreviewHud";
import { ImagePreviewContinuation } from "./ImagePreviewContinuation";
import { VideoPlayer } from "./VideoPlayer";
import { AudioDetailPlayer } from "./AudioDetailPlayer";
import { VideoTranscriptPanel, type VideoAnalysisView } from "./VideoTranscriptPanel";
import { BcoinAmount } from "./BcoinAmount";
import { LibraryVideoReplication } from "./LibraryVideoReplication";
import { VideoVisualAnalysis, useVideoVisualAnalysis } from "./VideoVisualAnalysis";
import { loadImagePreviewHistory } from "../lib/imagePreviewContinuation";
import { useStore } from "../store";
import "./CreationImagePreview.css";

export function CreationImagePreview({ asset: originalAsset, projectId, job: providedJob, onClose, video, audio, navigation,
  workflowOrigin, parentNodeId, onCreateWorkflowFromAsset, openTranscript }: {
  asset: Asset;
  projectId: string | null;
  job?: GenJob;
  onClose: () => void;
  openTranscript?: boolean;
  video?: Pick<ComponentProps<typeof VideoPlayer>, "path" | "sourceKey" | "frameTarget" | "onAddFrame" | "onAddFrameToCanvas" | "onSaveTrim">;
  audio?: { path: string; sourceKey?: string; onSaveTrim: (request: VideoTrimRequest) => Promise<Asset> };
  navigation?: { index: number; count: number; assetIds?: readonly string[]; onIndexChange: (index: number) => void };
  workflowOrigin?: { nodeId: string; title?: string };
  parentNodeId?: string | null;
  onCreateWorkflowFromAsset?: (asset: Asset) => void;
}) {
  const originKey = `${projectId ?? ""}:${originalAsset.id}`;
  const [view, setView] = useState<{ originKey: string; asset: Asset }>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const asset = view?.originKey === originKey ? view.asset : originalAsset;
  const job = originalAsset.generation_session_id && providedJob?.sessionId && originalAsset.generation_session_id !== providedJob.sessionId
    ? undefined : providedJob;
  const navigationIndex = navigation?.assetIds?.indexOf(asset.id);
  const visibleIndex = navigationIndex !== undefined && navigationIndex >= 0 ? navigationIndex : navigation?.index ?? 0;
  const media = video ?? audio;
  const mediaLabel = audio ? "音频" : video ? "视频" : "图片";
  const mediaDetail = `${mediaLabel}详情`;
  const localVideo = !!video && asset.source === "comfy-h3";
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
  const [videoAnalysis, setVideoAnalysis] = useState<{ key: string; view: VideoAnalysisView | "replication" | null }>();
  const [videoSeek, setVideoSeek] = useState<{ key: string; time: number; revision: number }>();
  const [mediaReplacement, setMediaReplacement] = useState<{ key: string; revision: number; duration?: number | null }>();
  const [measuredAudio, setMeasuredAudio] = useState<{ key: string; duration: number }>();
  const [followLatest, setFollowLatest] = useState(false);
  const [continuation, setContinuation] = useState<{ originKey: string; jobId: string; turnKey?: string }>();
  const submitted = continuation?.originKey === originKey ? continuation : undefined;
  const liveId = submitted?.jobId ?? job?.id;
  const liveJob = useStore(state => liveId ? state.genJobs[liveId] : undefined);
  const entitlement = useStore(state => state.cloudEntitlement);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageAnchorRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const analysisHeading = useRef<HTMLHeadingElement>(null);
  const analysisOpener = useRef<HTMLElement | null>(null);
  const pressedPanelRef = useRef<HTMLElement | null>(null);
  const blankPress = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const detailsTimer = useRef<ReturnType<typeof setTimeout>>();
  const inspectorTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const pointerFrame = useRef(0);
  const outputRequest = useRef(0);
  const [outputError, setOutputError] = useState<{ originKey: string; message: string }>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const originalPath = media ? null : asset.store_path ?? asset.thumb_path;
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
  const imageAvailable = !!media || !!path && (loadedImage === path || failedImage === path)
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
    setFollowLatest(false);
    return () => { outputRequest.current++; };
  }, [originKey]);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surfaceRef.current?.querySelector<HTMLElement>(video ? ".video-player" : '[aria-label="关闭预览"]')?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useLayoutEffect(() => {
    if (document.activeElement === document.body) {
      surfaceRef.current?.querySelector<HTMLElement>('[aria-label="关闭预览"]')?.focus({ preventScroll: true });
    }
  }, [requestKey]);

  useEffect(() => {
    if (job || openTranscript || !contentMounted || (audio && !asset.generation_session_id)) return;
    let current = true;
    setHistory(null);
    void (async () => {
      try {
        const restored = await loadImagePreviewHistory(asset, projectId, localVideo || undefined);
        if (current) setHistory({ key: requestKey, job: restored });
      } catch (reason) {
        if (current) setHistory({ key: requestKey, job: null, error: reason });
      }
    })();
    return () => { current = false; };
  }, [asset.id, asset.generation_session_id, projectId, job, requestKey, retry, contentMounted, localVideo, openTranscript, !!audio]);

  const ready = history?.key === requestKey ? history : null;
  const source = liveJob ?? job ?? ready?.job;
  const sourceJobId = liveJob?.id ?? job?.id ?? null;
  const showOutput = useCallback(async (outputPath: string, manual = false) => {
    const request = ++outputRequest.current;
    setOutputError(undefined);
    if (manual) setFollowLatest(false);
    try {
      let output = outputPath === originalAsset.store_path ? originalAsset
        : useStore.getState().assets.find(candidate => candidate.store_path === outputPath);
      if (!output) {
        const id = await api.localAgentFindAssetId(outputPath);
        if (id) output = (await api.getAssetsByIds([id])).find(candidate => candidate.id === id && candidate.store_path === outputPath);
      }
      if (!output) throw new Error("暂时无法打开这张生成图片");
      if (outputRequest.current === request) setView(output.id === originalAsset.id ? undefined : { originKey, asset: output });
    } catch (reason) {
      if (outputRequest.current === request) setOutputError({ originKey, message: userErrorMessage(reason, "暂时无法打开这张生成图片") });
    }
  }, [originalAsset, originKey]);
  const completedPath = !media && followLatest && submitted?.turnKey && liveJob && !liveJob.running
    ? liveJob.turns.find(turn => turn.turnKey === submitted.turnKey && !turn.error)?.images[0] : undefined;
  useEffect(() => {
    if (completedPath) void showOutput(completedPath);
  }, [completedPath, showOutput]);
  const snapshot = useMemo(() => {
    if (!source || !contentMounted) return null;
    const previewJob = { ...source, id: `image-preview:${asset.id}`, conversationId: undefined,
      turns: source.turns.map(turn => ({ ...turn, turnKey: turn.turnKey ?? `${turn.id}` })) };
    const selected = (followLatest ? previewJob.turns[previewJob.turns.length - 1] : previewJob.turns.find(turn => !!asset.store_path && turn.images.includes(asset.store_path)))
      ?? previewJob.turns[previewJob.turns.length - 1];
    return { job: previewJob, sourceJobId, selectedTurnKey: selected?.turnKey ?? "", onReuse: () => {} };
  }, [source, asset.id, asset.store_path, sourceJobId, contentMounted, followLatest]);
  const currentTurn = snapshot?.job.turns.find(turn => !!asset.store_path && turn.images.includes(asset.store_path));
  const detailTurn = currentTurn ?? snapshot?.job.turns.find(turn => turn.turnKey === snapshot.selectedTurnKey);
  const modelLabel = detailTurn?.videoOptions ? videoModelLabel(detailTurn.videoOptions.model_version)
    : detailTurn && (!video || localVideo) ? imageProviderLabel(detailTurn.provider || snapshot?.job.provider, entitlement, snapshot?.job.dreaminaModelVersion ?? null) : null;
  const generationRatio = detailTurn?.ratio ?? (snapshot?.job.turns.length === 1 ? snapshot.job.lastRatio : null);
  const singleTurn = !media && detailTurn && snapshot?.job.turns.length === 1 && !snapshot.job.running && !detailTurn.error;
  const references = detailTurn?.refAssets?.length ? detailTurn.refAssets : snapshot?.job.refAssets ?? [];
  const referencePaths = detailTurn?.refs?.length ? detailTurn.refs : references.flatMap(reference => reference.store_path ? [reference.store_path] : []);
  const hasConversation = !!job || !!snapshot || !!workflowOrigin || ready?.error != null || (!ready && (!!asset.generation_session_id || localVideo));
  const conversationContentReady = imageIntroduced && (!!snapshot || !!ready);
  const conversationVisible = conversationContentReady && conversationKey === requestKey;
  const videoKey = `${requestKey}:${media?.path}:${media?.sourceKey ?? ""}`;
  const replacement = mediaReplacement?.key === videoKey ? mediaReplacement : undefined;
  const transcriptKey = `${videoKey}:${replacement?.revision ?? 0}`;
  const selectedVideoView = videoAnalysis?.key === videoKey ? videoAnalysis.view : openTranscript ? "transcript" : null;
  const workspaceView = media ? selectedVideoView : null;
  const workspaceOpen = !!workspaceView;
  const cloudAuth = useStore(state => state.cloudAuth);
  const transcriptOwner = cloudAuth?.cloud_available && cloudAuth.logged_in ? cloudAuth.user_id : null;
  const transcriptPrice = useVideoTranscriptPrice(media && contentMounted ? transcriptOwner : null);
  const duration = measuredAudio?.key === transcriptKey ? measuredAudio.duration : replacement ? replacement.duration : asset.duration;
  const visualAnalysis = useVideoVisualAnalysis(video && contentMounted ? asset.id : undefined, transcriptKey);
  const videoAnalysisStatus = transcriptPrice.credits !== null ? <>转录 · <BcoinAmount amount={transcriptPrice.credits}/></>
    : transcriptPrice.loading ? "正在读取价格…"
    : transcriptPrice.connectionError ? "暂时无法连接转录服务"
    : transcriptPrice.reason === "pilot_exhausted" ? "试转录名额已使用"
    : cloudAuth?.cloud_available && !transcriptOwner ? "登录后可转录" : "转录服务暂不可用";

  useLayoutEffect(() => {
    if (workspaceOpen) {
      analysisHeading.current?.focus({ preventScroll: true });
    } else if (analysisOpener.current) {
      analysisOpener.current.focus({ preventScroll: true });
      analysisOpener.current = null;
    }
  }, [workspaceOpen, videoKey]);

  function selectAnalysisView(view: VideoAnalysisView | "replication") {
    if (!workspaceOpen) {
      analysisOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!openTranscript && transcriptPrice.unavailable) transcriptPrice.refresh();
    }
    setVideoAnalysis({ key: videoKey, view });
  }

  function dismiss() {
    if (!workspaceOpen || openTranscript) { close(); return; }
    setVideoAnalysis({ key: videoKey, view: null });
  }

  async function saveMediaTrim(request: VideoTrimRequest) {
    const result = await (audio?.onSaveTrim ?? video?.onSaveTrim ?? api.trimVideo)(request);
    if (request.overwrite && result?.id === asset.id) {
      setMediaReplacement(previous => ({
        key: videoKey, revision: (previous?.key === videoKey ? previous.revision : 0) + 1, duration: result.duration,
      }));
      if (audio) {
        setView({ originKey, asset: result });
        useStore.setState(state => ({
          assets: state.assets.map(item => item.id === result.id ? result : item),
          promptedAssets: state.promptedAssets.map(item => item.id === result.id ? result : item),
        }));
      }
    }
    return result;
  }
  useEffect(() => {
    if (!conversationContentReady) return;
    // The read-only conversation builds its prompt views on mount; reveal after that commit.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setConversationKey(requestKey)); });
    return () => cancelAnimationFrame(frame);
  }, [conversationContentReady, requestKey]);

  function close() {
    outputRequest.current++;
    if (closeTimer.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { closeRef.current(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => closeRef.current(), 140);
  }
  function navigateMedia(index: number) {
    outputRequest.current++;
    setView(undefined);
    setFollowLatest(false);
    setOutputError(undefined);
    navigation?.onIndexChange(index);
  }
  function runCanvasAction(action: () => void) {
    outputRequest.current++;
    closeRef.current();
    action();
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
    return target instanceof Element && (target.matches(".creation-image-preview, .creation-image-preview-backdrop")
      || (!workspaceOpen && target.matches(".creation-image-preview-layout")));
  }

  return createPortal(<div ref={surfaceRef} className={`creation-image-preview canvas-tactical${media ? " is-video-preview" : ""}${workspaceOpen ? " is-video-analysis" : ""}${closing ? " is-closing" : ""}`}
    role="dialog" aria-modal="true" aria-label={workspaceOpen ? `${mediaLabel}分析工作区` : audio ? mediaDetail : `${mediaLabel}与生成记录预览`}
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
        && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4) dismiss();
    }}
    onPointerMove={event => {
      const press = blankPress.current;
      if (press && event.buttons && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 4) press.moved = true;
      // An inline editor can unmount on Escape without dispatching blur.
      unlockPanels();
      if (workspaceOpen || event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !(event.target instanceof Element)) return;
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
      if (event.key === "Escape" && !document.fullscreenElement) { event.preventDefault(); dismiss(); }
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
      {workspaceOpen && <header className="video-analysis-header">
        {!openTranscript && <button type="button" className="video-analysis-icon-button" onClick={dismiss}
          aria-label={`返回${mediaLabel}预览`} title={`返回${mediaLabel}预览`}><ArrowLeft size={18} aria-hidden="true"/></button>}
        <div className="video-analysis-heading">
          <h2 ref={analysisHeading} tabIndex={-1}>{mediaLabel}分析</h2>
          <p title={asset.name}>{asset.name}</p>
        </div>
        <div className="video-analysis-tabs" role="group" aria-label={`${mediaLabel}分析视图`}>
          <button type="button" aria-pressed={workspaceView === "analysis" || workspaceView === "replication"} onClick={() => selectAnalysisView("analysis")}>分析</button>
          <button type="button" aria-pressed={workspaceView === "transcript"} onClick={() => selectAnalysisView("transcript")}>转录文稿</button>
        </div>
        <button type="button" className="video-analysis-icon-button" onClick={close}
          aria-label={`关闭${mediaLabel}分析`} title={`关闭${mediaLabel}分析`}><X size={19} aria-hidden="true"/></button>
      </header>}
      {!openTranscript && hasConversation && <section className={`creation-image-preview-conversation creation-image-preview-record ${!detailsOpen ? "is-collapsed" : conversationVisible ? "is-ready" : "is-loading"}${detailsClosing ? " is-leaving" : ""}`}
        aria-label="生成记录" aria-hidden={workspaceOpen || !conversationVisible || !detailsOpen || detailsClosing} hidden={workspaceOpen}>
        <div className="creation-image-preview-conversation-plane" aria-hidden="true"/>
        <header className="creation-image-preview-conversation-head">
          <h2>生成记录</h2>
          {!media && snapshot && snapshot.job.turns.length > 1 && <span>共 {snapshot.job.turns.length} 轮</span>}
          <button type="button" onClick={toggleDetails} aria-label="收起生成记录面板" title="收起生成记录"><PanelLeftClose size={16}/></button>
        </header>
        {imageIntroduced && (workflowOrigin || snapshot) && <div className="creation-image-preview-record-source">
          <span title={workflowOrigin?.title}>{workflowOrigin ? "画布生成卡" : `当前${mediaLabel}`}{modelLabel && ` · ${modelLabel}`}{generationRatio && ` · ${generationRatio}`}</span>
        </div>}
        <div className="creation-image-preview-history">
          {imageIntroduced && contentMounted && (snapshot ? singleTurn ? <div className="creation-image-preview-parameters">
            <h3>提示词</h3>
            <p>{detailTurn.promptRaw?.trim() || detailTurn.prompt}</p>
            {referencePaths.length > 0 && <>
              <h3>参考图</h3>
              <ul>{referencePaths.map((reference, i) => {
                const resolved = references.find(ref => ref.store_path === reference);
                return <li key={`${i}:${reference}`}><img src={convertFileSrc(resolved?.thumb_path ?? reference)} alt={resolved?.name ?? `参考图 ${i + 1}`} loading="lazy"/></li>;
              })}</ul>
            </>}
          </div> : <GenerationPanel embedded readOnly followLatest={followLatest} hydratedAssets={[asset, ...snapshot.job.refAssets]}
            previewOutput={media ? undefined : { path: asset.store_path ?? null, onSelect: path => void showOutput(path, true) }}
            onAddVideoFrame={video?.onAddFrame} onSaveVideoTrim={video?.onSaveTrim ? saveMediaTrim : undefined}
            snapshot={snapshot} /> : <div className="creation-image-preview-info">
          {!job && !ready ? <p role="status">正在读取生成记录…</p> : ready?.error != null
            ? <div className="creation-image-preview-error" role="alert"><p>{userErrorMessage(ready.error, "生成记录暂时无法读取，请重试。")}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
            : <p>暂无生成记录</p>}
          </div>)}
        </div>
        {!media && outputError?.originKey === originKey && <p className="creation-image-preview-action-note" role="alert">{outputError.message}</p>}
        {!media && imageIntroduced && contentMounted && source && (source.sessionId ? <ImagePreviewContinuation key={requestKey}
          asset={asset} job={source} sourceJobId={sourceJobId} parentNodeId={asset.id === originalAsset.id ? parentNodeId : null} enabled={!closing}
          draft={{ value: drafts[requestKey] ?? "", onChange: value => setDrafts(previous => ({ ...previous, [requestKey]: value })) }}
          onSent={(jobId, turnKey) => { setContinuation({ originKey, jobId, turnKey }); setFollowLatest(true); }}/>
          : <div className="creation-image-preview-action-note">
            <span>此图片未保存可续接的会话</span>
            {!workflowOrigin && onCreateWorkflowFromAsset && <button type="button" onClick={() => runCanvasAction(() => onCreateWorkflowFromAsset(asset))}>基于此图新建生成卡</button>}
          </div>)}
        <span className="creation-image-preview-panel-mark" aria-hidden="true"/>
      </section>}
      <section className="creation-image-preview-image" aria-label={media ? `播放${mediaLabel}` : "放大图片"}>
        <figure className="creation-image-preview-figure" style={{ "--image-ratio": imageRatio } as CSSProperties}>
          <div ref={imageAnchorRef} className="creation-image-preview-image-anchor" style={(media
            ? { "--image-scale": 1 }
            : { ...zoom.style, cursor: zoom.dragging ? "grabbing" : "grab", "--image-scale": zoom.scale }) as CSSProperties & { "--image-scale": number }}>
            <div className="creation-image-preview-image-depth" aria-hidden="true"><i/><i/></div>
            {video ? <VideoPlayer key={`${video.path}:${video.sourceKey ?? ""}`} {...video}
              onSaveTrim={video.onSaveTrim ? saveMediaTrim : undefined} seekRequest={videoSeek?.key === transcriptKey ? videoSeek : undefined}
              embedded fitContainer showTrim /> : audio ? (contentMounted && <AudioDetailPlayer key={videoKey} asset={asset}
                path={audio.path} sourceKey={transcriptKey} onSaveTrim={saveMediaTrim}
                duration={duration} onDuration={duration => setMeasuredAudio({ key: transcriptKey, duration })}
                seekRequest={videoSeek?.key === transcriptKey ? videoSeek : undefined}/>) : <div className="creation-image-preview-image-viewport">
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
            </div>}
            <i className="creation-image-preview-image-mark start" aria-hidden="true"/>
            <i className="creation-image-preview-image-mark end" aria-hidden="true"/>
          </div>
        </figure>
      </section>
      {workspaceView && <section className="video-analysis-content" aria-label={workspaceView === "transcript" ? "转录文稿" : audio ? "转录操作" : "分析操作"}>
        {contentMounted && (audio || workspaceView === "transcript" ? <VideoTranscriptPanel key={transcriptKey} assetId={asset.id} sourceKey={transcriptKey}
          active={!closing} price={transcriptPrice} durationSeconds={duration} mediaKind={audio ? "audio" : "video"}
          onRead={audio && workspaceView === "analysis" ? () => {
            analysisHeading.current?.focus({ preventScroll: true });
            selectAnalysisView("transcript");
          } : undefined}
          onSeek={time => setVideoSeek(previous => ({ key: transcriptKey, time, revision: (previous?.revision ?? 0) + 1 }))}/>
          : <div className="video-transcript-panel" key={`${transcriptKey}:${workspaceView}`}>
            {workspaceView === "replication" ? <LibraryVideoReplication onBack={() => selectAnalysisView("analysis")}/> : <>
              <VideoVisualAnalysis key={visualAnalysis.owner} assetId={asset.id} state={visualAnalysis}/>
              <button type="button" className="app-button-primary mt-4" onClick={() => selectAnalysisView("replication")}>复刻</button>
            </>}
          </div>)}
      </section>}
      {!openTranscript && <section className={`creation-image-preview-conversation creation-image-preview-inspector ${!inspectorOpen ? "is-collapsed" : inspectorVisible ? "is-ready" : "is-loading"}${inspectorClosing ? " is-leaving" : ""}`}
        aria-label={mediaDetail} aria-hidden={workspaceOpen || !inspectorVisible || !inspectorOpen || inspectorClosing} hidden={workspaceOpen}>
        <div className="creation-image-preview-conversation-plane" aria-hidden="true"/>
        <header className="creation-image-preview-conversation-head">
          <h2>{mediaDetail}</h2>
          <button type="button" onClick={toggleInspector} aria-label={`收起${mediaDetail}面板`} title={`收起${mediaDetail}`}><PanelRightClose size={16}/></button>
        </header>
        {contentMounted && <AssetDetail key={requestKey} panelOnly initialAsset={asset}
          onReady={() => setInspectorKey(requestKey)}
          onOpenVideoAnalysis={media ? selectAnalysisView : undefined}
          videoAnalysisStatus={media ? videoAnalysisStatus : undefined}
          videoVisualQuote={video && visualAnalysis.quote?.chargeRequired ? visualAnalysis.quote.credits ?? undefined : undefined}
          selection={{ assetId: asset.id, onClose: close, onOpen: close, onNavigate: close }}/>}
        <span className="creation-image-preview-panel-mark" aria-hidden="true"/>
      </section>}
    </div>
    <div ref={hudRef} className="creation-image-preview-hud" hidden={workspaceOpen} aria-hidden={workspaceOpen}>
      <header className="creation-image-preview-image-head">
        <h2>{asset.name}</h2>
        <button type="button" onClick={close} aria-label="关闭预览" title="关闭预览（Esc）"><X size={17}/></button>
      </header>
      <footer className="creation-image-preview-image-foot">
        <span>{dimensions?.width && dimensions.height ? `${dimensions.width} × ${dimensions.height}` : ""}{asset.ext && <b>{asset.ext.toUpperCase()}</b>}</span>
        <div>
          {navigation && navigation.count > 1 && <>
            <button type="button" onClick={() => navigateMedia(visibleIndex - 1)} disabled={visibleIndex === 0}
              aria-label="上一项媒体" title="上一项媒体"><ChevronLeft size={16}/></button>
            <output className="creation-image-preview-scale" aria-label="媒体序号">{visibleIndex + 1} / {navigation.count}</output>
            <button type="button" onClick={() => navigateMedia(visibleIndex + 1)} disabled={visibleIndex === navigation.count - 1}
              aria-label="下一项媒体" title="下一项媒体"><ChevronRight size={16}/></button>
          </>}
          {!media && <>
          <button type="button" onClick={() => zoom.zoomBy(1 / 1.25)} disabled={zoom.scale <= 0.1} title="缩小" aria-label="缩小图片"><ZoomOut size={16}/></button>
          <output className="creation-image-preview-scale" aria-label="图片缩放比例">{Math.round(zoom.scale * 100)}%</output>
          <button type="button" onClick={() => zoom.zoomBy(1.25)} disabled={zoom.scale >= 16} title="放大" aria-label="放大图片"><ZoomIn size={16}/></button>
          <button type="button" onClick={zoom.reset} title="适应画面" aria-label="适应画面"><Focus size={16}/></button>
          </>}
          {media && <button type="button" aria-label="打开转录文稿" title="转录文稿" onClick={() => selectAnalysisView("transcript")}><FileText size={16}/></button>}
          {hasConversation && conversationVisible && <button ref={detailsToggleRef} type="button" onClick={toggleDetails} aria-pressed={detailsOpen && !detailsClosing}
            title={detailsOpen && !detailsClosing ? "收起生成记录" : "显示生成记录"} aria-label={detailsOpen && !detailsClosing ? "收起生成记录" : "显示生成记录"}>
            <PanelLeft size={16}/>
          </button>}
          {inspectorVisible && <button ref={inspectorToggleRef} type="button" onClick={toggleInspector} aria-pressed={inspectorOpen && !inspectorClosing}
            title={inspectorOpen && !inspectorClosing ? `收起${mediaDetail}` : `显示${mediaDetail}`} aria-label={inspectorOpen && !inspectorClosing ? `收起${mediaDetail}` : `显示${mediaDetail}`}><PanelRight size={16}/></button>}
        </div>
      </footer>
    </div>
  </div>, document.body);
}
