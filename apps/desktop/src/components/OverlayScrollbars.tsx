import { useLayoutEffect } from "react";
import "../lib/overlayScrollbars.js";
import "./OverlayScrollbars.css";

declare global { interface Window { enableBowerbirdOverlayScrollbars(): () => void } }

/** The application root and isolated scroll-area previews share one DOM manager. */
export function enableOverlayScrollbars() {
  return window.enableBowerbirdOverlayScrollbars();
}

export function OverlayScrollbars() {
  useLayoutEffect(enableOverlayScrollbars, []);
  return null;
}
