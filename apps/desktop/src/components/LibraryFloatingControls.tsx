import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { MoreHorizontal } from "lucide-react";

/** Shared overflow for the controls beside the centered source switch. */
export function LibraryFloatingControls({ children, controlsRef }: { children: ReactNode; controlsRef?: RefObject<HTMLDivElement> }) {
  const root = useRef<HTMLDivElement>(null);
  const ownControls = useRef<HTMLDivElement>(null);
  const controls = controlsRef ?? ownControls;
  const trigger = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const host = root.current!, row = controls.current!, heading = host.closest<HTMLElement>(".file-view-heading")!;
    const navigation = heading.querySelector<HTMLElement>(".library-view-switch");
    if (!navigation) return;
    let wasCompact = false;
    const fit = () => {
      const width = row.scrollWidth;
      const projected = heading.matches(":has(.library-source-navigation)");
      const navStyle = getComputedStyle(navigation), headingStyle = getComputedStyle(heading);
      const expandedNavigation = parseFloat(navStyle.getPropertyValue('--lp-navigation-width')) || 0;
      const types = row.querySelector<HTMLElement>('[aria-label="素材类型"]');
      const expandedTypes = parseFloat(headingStyle.getPropertyValue('--lp-media-width')) || 0;
      const expandedWidth = width + (types ? Math.max(0, expandedTypes - types.offsetWidth) : 0);
      const expandedAssembly = Math.max(navigation.getBoundingClientRect().width, expandedNavigation) + expandedWidth + 12;
      const next = projected
        ? expandedAssembly > heading.clientWidth
          || (heading.dataset.hoverAnchored === 'true' && navigation.getBoundingClientRect().right + expandedWidth + 12 > heading.getBoundingClientRect().right)
        : host.getBoundingClientRect().left + width > heading.getBoundingClientRect().right;
      if (!wasCompact && next && row.contains(document.activeElement)) setOpen(true);
      if (!next) setOpen(false);
      wasCompact = next; setCompact(next);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(heading); observer.observe(row); observer.observe(navigation);
    const position = new MutationObserver(fit);
    position.observe(heading, { attributes: true, attributeFilter: ['style', 'data-hover-anchored'] });
    fit();
    return () => { observer.disconnect(); position.disconnect(); };
  }, [controls]);
  useLayoutEffect(() => { if (controls.current) controls.current.inert = compact && !open; }, [compact, open, controls]);
  useLayoutEffect(() => {
    const row = controls.current!, host = root.current!, heading = host.closest<HTMLElement>('.file-view-heading')!;
    if (!compact || !open) { row.style.translate = ''; return; }
    const align = () => {
      const bounds = heading.getBoundingClientRect(), right = host.getBoundingClientRect().right;
      row.style.translate = Math.max(bounds.left - (right - row.offsetWidth), Math.min(0, bounds.right - right)) + 'px';
    };
    const observer = new ResizeObserver(align); observer.observe(heading); observer.observe(row); align();
    return () => { observer.disconnect(); row.style.translate = ''; };
  }, [compact, open, controls]);
  useEffect(() => {
    if (!compact || !open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [compact, open]);
  return <div ref={root} className={`library-controls-host${compact ? " is-compact" : ""}${open ? " is-open" : ""}`}
    onKeyDown={event => {
      if (compact && open && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      }
    }}>
    {compact && <button ref={trigger} className="library-filter-trigger" aria-label="更多素材库控件" title="更多"
      aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><MoreHorizontal size={16}/></button>}
    <div ref={controls} className="folder-floating-controls" role={compact && open ? "dialog" : undefined}
      aria-label={compact && open ? "素材库控件" : undefined} aria-hidden={compact && !open ? true : undefined}>{children}</div>
  </div>;
}
