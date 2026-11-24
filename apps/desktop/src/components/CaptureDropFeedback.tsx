import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { captureDropMessage, type CaptureDropTarget } from "../lib/captureDropTarget";
import { useStore } from "../store";
import "./CaptureDropFeedback.css";

type CaptureHint = { target: CaptureDropTarget; gallery: HTMLElement | null; host: HTMLElement | null; boundary: Element | null; message: string };

export function useCaptureDropFeedback(source: "explorer" | "files") {
  const [hint, setHint] = useState<CaptureHint | null>(null);
  const clear = useCallback(() => setHint(null), []);
  const show = useCallback((target: CaptureDropTarget, hit: EventTarget | null) => {
    const element = hit instanceof Element ? hit : null;
    const catalog = element?.closest(".categorized-library");
    const gallery = catalog?.querySelector<HTMLElement>(".catalog-gallery") ?? null;
    const host = gallery ?? element?.closest<HTMLElement>(".explore-main, [data-library-pane]") ?? null;
    // The sidebar and the gallery share a drop boundary, even though the bubble sits in the gallery.
    const boundary = catalog ?? host;
    const message = captureDropMessage(target, source === "files" && !gallery);
    setHint(previous => previous && previous.target.kind === target.kind && previous.target.id === target.id
      && previous.target.element === target.element && previous.host === host && previous.boundary === boundary && previous.message === message
      ? previous : { target, gallery, host, boundary, message });
  }, [source]);

  useLayoutEffect(() => {
    if (!hint) return;
    const { target } = hint;
    if (target.kind !== "folder" && target.kind !== "tag") return;
    const element = target.element;
    if (!element) return;
    const catalog = element.closest(".categorized-library");
    const id = CSS.escape(target.id);
    const selector = target.kind === "folder"
      ? `.catalog-row[data-collection-id="${id}"], [data-catalog-section][data-file-import-collection-id="${id}"]`
      : `.catalog-row[data-tag-id="${id}"], [data-catalog-section][data-tag-section="${id}"]`;
    const marked = new Set([element, ...Array.from(catalog?.querySelectorAll(selector) ?? [])]);
    for (const node of marked) node.setAttribute("data-capture-drop-target", target.disabled ? "blocked" : "ready");
    return () => { for (const node of marked) node.removeAttribute("data-capture-drop-target"); };
  }, [hint]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    const leave = (event: DragEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node)) { clear(); return; }
      setHint(previous => {
        const boundary = previous?.boundary;
        return boundary && !boundary.contains(next) ? null : previous;
      });
    };
    const unsubscribe = useStore.subscribe((current, previous) => {
      if (current.activeProjectId !== previous.activeProjectId || current.projectRouteRevision !== previous.projectRouteRevision
        || current.projectRoutePending !== previous.projectRoutePending) clear();
    });
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", clear);
    return () => {
      unsubscribe();
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [clear]);

  const feedback = hint && createPortal(
    <div className={`capture-drop-layer${hint.host ? " is-local" : ""}${hint.gallery ? " is-gallery" : ""}`}
      data-file-drop-overlay={source === "files" || undefined}>
      <div className={`capture-drop-bubble${source === "explorer" ? " explore-drop-hint" : ""}`} role="status"
        data-capture-drop-hint={hint.target.disabled ? "blocked" : "ready"}>{hint.message}</div>
    </div>, hint.host ?? document.body,
  );
  return { feedback, show, clear };
}
