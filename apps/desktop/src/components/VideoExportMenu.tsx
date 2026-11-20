import { useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { PortalTargetContext, usePortalTarget } from "../lib/portalTarget";

/** Actions use the shared menu, including fullscreen and keyboard focus ownership. */
export function VideoExportMenu({ label, icon, disabled, portal, items }: {
  label: string; icon: ReactNode; disabled?: boolean; portal?: HTMLElement | null;
  items: { label: string; disabled?: boolean; run: () => void }[];
}) {
  const inheritedPortal = usePortalTarget();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const anchor = trigger.current;
  // The modal shell is outside the preview figure's animated transform.
  const menuPortal = portal && document.fullscreenElement === portal
    ? portal
    : anchor?.closest<HTMLElement>('[aria-modal="true"]') ?? portal ?? inheritedPortal;
  return <div className="video-export-menu" onClick={event => event.stopPropagation()}>
    <button ref={trigger} disabled={disabled} aria-haspopup="menu" aria-expanded={open && !disabled}
      onClick={() => setOpen(current => !current)}>
      {icon}{label}<ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && !disabled && anchor && <PortalTargetContext.Provider value={menuPortal}>
      <ContextMenu anchor={anchor} label={label} onClose={() => setOpen(false)} className="video-export-popup">
        {items.map(item => <button key={item.label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={item.disabled}
          onClick={() => {
            // Saving disables the trigger, so return focus to the player before closing.
            portal?.focus({ preventScroll: true });
            setOpen(false); item.run();
          }}>{item.label}</button>)}
      </ContextMenu>
    </PortalTargetContext.Provider>}
  </div>;
}
