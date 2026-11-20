import { useLayoutEffect, useRef } from "react";

const OPEN_MENU = "bowerbird:context-menu-open";

export function announceContextMenu(owner: string) {
  window.dispatchEvent(new CustomEvent(OPEN_MENU, { detail: owner }));
}

export function subscribeContextMenuOpen(listener: (event: Event) => void) {
  window.addEventListener(OPEN_MENU, listener);
  return () => window.removeEventListener(OPEN_MENU, listener);
}

export function useContextMenuOwnership(owner: string, open: boolean, onSuperseded: () => void) {
  const superseded = useRef(false);
  const close = useRef(onSuperseded);
  close.current = onSuperseded;
  useLayoutEffect(() => {
    if (!open) return;
    superseded.current = false;
    const another = (event: Event) => {
      if ((event as CustomEvent<string>).detail === owner || superseded.current) return;
      superseded.current = true;
      close.current();
    };
    const unsubscribe = subscribeContextMenuOpen(another);
    announceContextMenu(owner);
    return unsubscribe;
  }, [open, owner]);
  return superseded;
}
