import { ContextMenu } from "./ContextMenu";

export interface DisconnectChoice { key: string; label: string; detail: string; disabled: boolean; disconnect: () => void }
export function WorkflowDisconnectMenu({ x, y, choices, onClose }: { x: number; y: number; choices: DisconnectChoice[]; onClose: () => void }) {
  return <ContextMenu x={x} y={y} label="选择要断开的连线" onClose={onClose}>
    <div className="app-context-label">选择要断开的连线</div>
    {choices.map(choice => <button className="app-context-item px-2 py-1.5" key={choice.key} role="menuitem" disabled={choice.disabled} title={`${choice.label} · ${choice.detail}`} onClick={() => { onClose(); choice.disconnect(); }}>
      <span><b>{choice.label}</b><small className="context-menu-reason">{choice.detail}{choice.disabled ? " · 运行中" : ""}</small></span><span aria-hidden="true">断开</span>
    </button>)}
  </ContextMenu>;
}
