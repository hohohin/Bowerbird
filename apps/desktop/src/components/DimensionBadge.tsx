export function DimensionBadge({ assetId }: { assetId: string }) {
  return <button type="button" title="打开维度环" aria-label="打开维度环"
    className="pointer-events-auto rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation();
      const anchor = event.currentTarget.closest<HTMLElement>("[data-canvas-node-id], [data-asset-id]") ?? event.currentTarget;
      window.dispatchEvent(new CustomEvent("bowerbird://board-asset-peek", { detail: { assetId, anchor } }));
    }}>🏷️</button>;
}
