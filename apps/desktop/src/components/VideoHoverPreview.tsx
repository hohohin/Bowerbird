import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import "./VideoHoverPreview.css";

// One owner for delayed work and the decoder, even across separate library panes.
let owner: { host: HTMLElement; stop: () => void } | undefined;

function stopPreview(host: HTMLElement) {
  if (owner?.host === host) owner.stop();
}

function queuePreview(host: HTMLElement, path: string, version: string | number) {
  owner?.stop();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const blocked = () => !host.isConnected || document.hidden || !host.getClientRects().length
    || getComputedStyle(host).visibility === "hidden"
    || !!host.parentElement?.closest('[hidden], [aria-hidden="true"], .is-view-hidden')
    || !!document.querySelector('[aria-modal="true"]');
  if (motion.matches || blocked()) return;
  let video: HTMLVideoElement | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    intersection.disconnect(); mutations.disconnect();
    document.removeEventListener("visibilitychange", stop);
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("keydown", stop, true);
    window.removeEventListener("blur", stop);
    window.removeEventListener("scroll", stop, true);
    motion.removeEventListener("change", stop);
    if (video) {
      video.pause(); video.removeAttribute("src"); video.load(); video.remove();
    }
    if (owner?.host === host) owner = undefined;
  };
  const intersection = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) stop(); });
  const mutations = new MutationObserver(() => { if (blocked()) stop(); });
  const timer = window.setTimeout(() => {
    if (blocked()) { stop(); return; }
    video = document.createElement("video");
    video.className = "folder-media-hover-video";
    video.setAttribute("aria-hidden", "true");
    video.muted = true; video.defaultMuted = true; video.playsInline = true; video.loop = true;
    video.preload = "none";
    video.addEventListener("error", stop, { once: true });
    video.addEventListener("loadeddata", () => video?.classList.add("is-ready"), { once: true });
    video.src = `${convertFileSrc(path)}?preview=${encodeURIComponent(version)}`;
    host.append(video);
    void video.play().catch(stop);
  }, 500);
  owner = { host, stop };
  intersection.observe(host);
  // Only the active card observes its ancestors; card/list style changes elsewhere
  // cannot multiply layout reads. Child changes catch a portal opening over it.
  for (let element: HTMLElement | null = host; element; element = element.parentElement) {
    mutations.observe(element, { attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
  }
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
  document.addEventListener("visibilitychange", stop);
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("keydown", stop, true);
  window.addEventListener("blur", stop);
  window.addEventListener("scroll", stop, { capture: true, passive: true });
  motion.addEventListener("change", stop);
}

export function VideoHoverPreview({ path, version, enabled }: { path: string; version: string | number; enabled: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current;
    const card = host?.closest("button");
    if (!host || !card || !enabled) return;
    const start = (event: PointerEvent) => { if (event.pointerType !== "touch") queuePreview(host, path, version); };
    const stop = () => stopPreview(host);
    card.addEventListener("pointerenter", start);
    card.addEventListener("pointerleave", stop);
    card.addEventListener("dragstart", stop);
    return () => {
      stop();
      card.removeEventListener("pointerenter", start);
      card.removeEventListener("pointerleave", stop);
      card.removeEventListener("dragstart", stop);
    };
  }, [path, version, enabled]);
  return <span ref={ref} className="folder-media-hover" aria-hidden="true" />;
}

export function videoDurationLabel(duration?: number | null) {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return null;
  const seconds = Math.max(1, Math.floor(duration));
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, "0");
  return minutes < 60 ? `${minutes}:${tail}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`;
}
