import { useEffect, useRef } from "react";
import "./LibraryMotion.css";

/** One observer per library; keyed cards only enter once, including after background refreshes. */
export function LibraryMotion() {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = layer.current!.parentElement!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const seen = new WeakSet<Element>();
    let visible = true;
    const updatePause = () => {
      root.dataset.libraryMotionPaused = String(document.hidden || !document.hasFocus() || !visible);
    };
    const cardsIn = (node: Node) => node instanceof Element
      ? [...(node.matches(".folder-media-card") ? [node] : []), ...node.querySelectorAll(".folder-media-card")]
      : [];
    const observer = new IntersectionObserver(entries => {
      let order = 0;
      for (const entry of entries) {
        if (entry.target === root) { visible = entry.isIntersecting; updatePause(); continue; }
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (seen.has(entry.target)) continue;
        seen.add(entry.target);
        if (!reduced.matches && root.dataset.libraryMotionPaused === "false") {
          const card = entry.target as HTMLElement;
          card.style.setProperty("--library-enter-delay", `${Math.min(order++ * 28, 140)}ms`);
          card.classList.add("library-card-enter");
        }
      }
    }, { threshold: .05 });
    const watch = (card: Element) => { if (!seen.has(card)) observer.observe(card); };
    const mutations = new MutationObserver(records => {
      for (const record of records) {
        record.removedNodes.forEach(node => cardsIn(node).forEach(card => observer.unobserve(card)));
        record.addedNodes.forEach(node => cardsIn(node).forEach(watch));
      }
    });
    const endEntry = (event: AnimationEvent) => {
      if (event.animationName === "library-material-enter" && event.target instanceof Element) {
        const card = event.target.closest(".folder-media-card");
        card?.classList.remove("library-card-enter");
      }
    };
    const clearEntry = () => root.querySelectorAll(".library-card-enter").forEach(card => card.classList.remove("library-card-enter"));
    const startDrag = () => { root.dataset.libraryDragging = "true"; clearEntry(); };
    const endDrag = () => { delete root.dataset.libraryDragging; };
    const blur = () => { endDrag(); updatePause(); };
    root.classList.add("library-motion-root");
    updatePause();
    observer.observe(root);
    root.querySelectorAll(".folder-media-card").forEach(watch);
    mutations.observe(root, { childList: true, subtree: true });
    root.addEventListener("animationend", endEntry);
    root.addEventListener("dragstart", startDrag);
    root.addEventListener("dragend", endDrag);
    root.addEventListener("drop", endDrag);
    reduced.addEventListener("change", clearEntry);
    document.addEventListener("visibilitychange", updatePause);
    window.addEventListener("focus", updatePause);
    window.addEventListener("blur", blur);
    return () => {
      observer.disconnect(); mutations.disconnect(); clearEntry(); endDrag();
      root.classList.remove("library-motion-root"); delete root.dataset.libraryMotionPaused;
      root.removeEventListener("animationend", endEntry);
      root.removeEventListener("dragstart", startDrag);
      root.removeEventListener("dragend", endDrag);
      root.removeEventListener("drop", endDrag);
      reduced.removeEventListener("change", clearEntry);
      document.removeEventListener("visibilitychange", updatePause);
      window.removeEventListener("focus", updatePause);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return <div ref={layer} className="library-ambient-light" aria-hidden="true" />;
}
