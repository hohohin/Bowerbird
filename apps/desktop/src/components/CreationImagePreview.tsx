import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Focus, MessageSquare, PanelRightClose, X } from "lucide-react";
import { api } from "../lib/api";
import type { Asset, GenJob } from "../lib/types";
import { useCompatibleImagePath } from "../lib/useCompatibleImagePath";
import { useImageZoom } from "../lib/useImageZoom";
import { userErrorMessage } from "../lib/userError";
import { GenerationPanel } from "./GenerationPanel";
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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  const detailsTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const path = useCompatibleImagePath(asset.store_path ?? asset.thumb_path);
  const zoom = useImageZoom(path);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ path: string; width: number; height: number } | null>(null);
  const dimensions = asset.width && asset.height ? asset : naturalSize?.path === path ? naturalSize : null;
  const imageRatio = dimensions?.width && dimensions.height ? dimensions.width / dimensions.height : 1;

  useEffect(() => {
    setClosing(false);
    setDetailsOpen(true);
    setDetailsClosing(false);
    return () => { clearTimeout(closeTimer.current); clearTimeout(detailsTimer.current); closeTimer.current = undefined; };
  }, [requestKey]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => surfaceRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (job) return;
    let current = true;
    setHistory(null);
    void (async () => {
      try {
        let result = await api.generationHistory(asset.id, projectId);
        // Library images can belong to another project; viewing never changes that ownership.
        if (projectId && !result.turns.length && asset.generation_session_id) result = await api.generationHistory(asset.id, null);
        if (!current) return;
        const restored: GenJob | null = result.turns.length ? {
          id: `image-preview:${asset.id}`, projectId, sessionId: result.session_id,
          media: result.media, videoOptions: result.video_options,
          turns: result.turns.map((turn, index) => ({
            id: index + 1, turnKey: turn.turn_key ?? `${index + 1}`, submitId: turn.submit_id,
            prompt: turn.prompt, promptRaw: turn.prompt_raw, appliedPrompt: turn.applied_prompt,
            images: turn.images, error: turn.error, media: turn.media, videoOptions: turn.video_options,
            ratio: turn.ratio, provider: turn.provider ?? undefined,
            refs: turn.references_resolved === false ? undefined : turn.references,
            referenceNodeIds: turn.reference_node_ids, refAssets: turn.ref_assets,
          })),
          running: false, streaming: "", createdAt: asset.created_at ?? 0,
          lastPrompt: result.turns[0].prompt, lastRefs: result.references.flatMap(reference => reference.store_path ? [reference.store_path] : []),
          refAssets: result.references, dimAssets: result.dimension_assets, lastRatio: result.ratio ?? null,
          provider: result.provider === "dreamina" ? "jimeng" : result.provider ?? "",
          visualProfile: result.visual_profile,
        } : null;
        setHistory({ key: requestKey, job: restored });
      } catch (reason) {
        if (current) setHistory({ key: requestKey, job: null, error: reason });
      }
    })();
    return () => { current = false; };
  }, [asset.id, asset.generation_session_id, projectId, job, requestKey, retry]);

  const ready = history?.key === requestKey ? history : null;
  const source = job ?? ready?.job;
  const snapshot = useMemo(() => {
    if (!source) return null;
    const previewJob = { ...source, id: `image-preview:${asset.id}`, conversationId: undefined,
      turns: source.turns.map(turn => ({ ...turn, turnKey: turn.turnKey ?? `${turn.id}` })) };
    const selected = previewJob.turns.find(turn => !!asset.store_path && turn.images.includes(asset.store_path))
      ?? previewJob.turns[previewJob.turns.length - 1];
    return { job: previewJob, sourceJobId: job?.id ?? null, selectedTurnKey: selected?.turnKey ?? "", onReuse: () => {} };
  }, [source, asset.id, asset.store_path, job?.id]);

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

  return createPortal(<div ref={surfaceRef} className={`creation-image-preview canvas-tactical${closing ? " is-closing" : ""}`}
    role="dialog" aria-modal="true" aria-label="图片与会话预览"
    onKeyDown={event => {
      // Nested media/menu portals own their keys even though React bubbles them here.
      if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node) || document.querySelector(".media-lightbox")) return;
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
          .filter(item => item.getClientRects().length && !item.closest('.is-leaving, [inert], [aria-hidden="true"]'));
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <div className="creation-image-preview-backdrop" aria-hidden="true" onMouseDown={close}/>
    <div className="creation-image-preview-layout">
      <section className="creation-image-preview-image" aria-label="放大图片">
        <figure className="creation-image-preview-figure" style={{ "--image-ratio": imageRatio } as CSSProperties}>
          <header className="creation-image-preview-image-head">
            <h2>{asset.name}</h2>
            <button type="button" onClick={close} aria-label="关闭预览" title="关闭预览（Esc）"><X size={17}/></button>
          </header>
          <div className="creation-image-preview-image-anchor">
            <div className="creation-image-preview-image-viewport">
              {path && failedImage !== path ? <img ref={zoom.imgRef} src={convertFileSrc(path)} alt={asset.name}
                draggable={false} style={zoom.style} onMouseDown={zoom.onMouseDown}
                onDoubleClick={event => { event.stopPropagation(); zoom.onDoubleClick(event); }}
                onLoad={event => setNaturalSize({ path, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                onError={() => setFailedImage(path)} />
                : <p role="status">{!asset.store_path && !asset.thumb_path || failedImage === path ? "图片暂时无法读取" : "正在读取图片…"}</p>}
            </div>
            <i className="creation-image-preview-image-mark start" aria-hidden="true"/>
            <i className="creation-image-preview-image-mark end" aria-hidden="true"/>
          </div>
          <figcaption className="creation-image-preview-image-foot">
            <span>{dimensions?.width && dimensions.height ? `${dimensions.width} × ${dimensions.height}` : ""}{asset.ext && <b>{asset.ext.toUpperCase()}</b>}</span>
            <div>
              <button type="button" onClick={zoom.reset} title="适应画面" aria-label="适应画面"><Focus size={16}/></button>
              <button ref={detailsToggleRef} type="button" onClick={toggleDetails} aria-pressed={detailsOpen && !detailsClosing}
                title={detailsOpen && !detailsClosing ? "收起会话" : "显示会话"} aria-label={detailsOpen && !detailsClosing ? "收起会话" : "显示会话"}><MessageSquare size={16}/></button>
            </div>
          </figcaption>
        </figure>
      </section>
      {detailsOpen && <section className={`creation-image-preview-conversation${detailsClosing ? " is-leaving" : ""}`} aria-label="独立会话面板">
        <div className="creation-image-preview-conversation-plane" aria-hidden="true"/>
        <header className="creation-image-preview-conversation-head">
          <h2>{snapshot ? "会话" : "素材"}</h2>{snapshot && <span>{snapshot.job.turns.length} 轮</span>}
          <button type="button" onClick={toggleDetails} aria-label="收起会话面板" title="收起会话"><PanelRightClose size={16}/></button>
        </header>
        <div className="creation-image-preview-history">
          {snapshot ? <GenerationPanel embedded readOnly hydratedAssets={[asset, ...snapshot.job.refAssets]}
            snapshot={snapshot} /> : <div className="creation-image-preview-info">
          {!job && !ready ? <p role="status">正在读取对话…</p> : ready?.error != null
            ? <div className="creation-image-preview-error" role="alert"><p>{userErrorMessage(ready.error, "对话详情暂时无法读取，请重试。")}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
            : null}
          <dl>
            {asset.width && asset.height ? <div><dt>尺寸</dt><dd>{asset.width} × {asset.height}</dd></div> : null}
            {asset.ext && <div><dt>格式</dt><dd>{asset.ext.toUpperCase()}</dd></div>}
            {asset.size ? <div><dt>大小</dt><dd>{asset.size >= 1024 * 1024 ? `${(asset.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(asset.size / 1024))} KB`}</dd></div> : null}
            {asset.source_url && <div><dt>来源</dt><dd>{asset.source_url}</dd></div>}
          </dl>
          </div>}
        </div>
        <span className="creation-image-preview-panel-mark" aria-hidden="true"/>
      </section>}
    </div>
  </div>, document.body);
}
