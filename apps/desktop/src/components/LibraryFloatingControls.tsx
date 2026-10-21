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
      const gallery = heading.closest<HTMLElement>(".catalog-gallery");
      gallery?.style.setProperty("--catalog-title-max-width", `${Math.max(44, navigation.getBoundingClientRect().left - gallery.getBoundingClientRect().left - 16)}px`);
      const width = row.scrollWidth;
      const next = navigation.getBoundingClientRect().right + 8 + width > heading.getBoundingClientRect().right;
      if (!wasCompact && next && row.contains(document.activeElement)) setOpen(true);
      if (!next) setOpen(false);
      wasCompact = next; setCompact(next);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(heading); observer.observe(row); observer.observe(navigation);
    fit();
    return () => observer.disconnect();
  }, [controls]);
  useLayoutEffect(() => { if (controls.current) controls.current.inert = compact && !open; }, [compact, open, controls]);
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
