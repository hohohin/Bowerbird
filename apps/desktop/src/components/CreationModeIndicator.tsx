import "./CreationModeIndicator.css";

/** The same creation-state marking surrounds the library and the canvas. */
export function CreationModeIndicator({ className = "" }: { className?: string }) {
  return <div className={`creation-mode-indicator ${className}`} aria-hidden="true">
    <div className="creation-mode-indicator-frame"/>
    <div className="creation-mode-indicator-label">创作模式</div>
  </div>;
}
