import { createContext, useContext } from "react";

/** Keep overlays inside an embedded workspace's stacking and focus boundary. */
export const PortalTargetContext = createContext<HTMLElement | null>(null);
export const usePortalTarget = () => useContext(PortalTargetContext) ?? document.body;
