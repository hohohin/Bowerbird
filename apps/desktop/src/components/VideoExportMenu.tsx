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
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  return <div className="video-export-menu" onClick={event => event.stopPropagation()}>
    <button ref={trigger} disabled={disabled} aria-haspopup="menu" aria-expanded={!!position}
      onClick={() => { const rect = trigger.current!.getBoundingClientRect(); setPosition(position ? null : { x: rect.left, y: rect.bottom + 4 }); }}>
      {icon}{label}<ChevronDown size={13} aria-hidden="true" />
    </button>
    {position && !disabled && <PortalTargetContext.Provider value={portal ?? inheritedPortal}>
      <ContextMenu {...position} label={label} trigger={trigger.current} onClose={() => setPosition(null)} className="video-export-popup">
        {items.map(item => <button key={item.label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={item.disabled}
          onClick={() => { setPosition(null); item.run(); }}>{item.label}</button>)}
      </ContextMenu>
    </PortalTargetContext.Provider>}
  </div>;
}
