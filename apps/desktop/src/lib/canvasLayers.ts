export const CANVAS_LAYER_STEP_EVENT = "bowerbird:canvas-layer-step";

export interface CanvasLayerStepDetail {
  projectId: string;
  nodeIds: string[];
  direction: -1 | 1;
}

/** Input order breaks equal z-index ties in the same order as the rendered cards. */
export function stepCanvasLayers(cards: readonly { id: string; order: number }[], selected: ReadonlySet<string>, direction: -1 | 1) {
  const ordered = [...cards].sort((a, b) => a.order - b.order);
  let moved = false;
  for (let i = direction === 1 ? ordered.length - 2 : 1;
    direction === 1 ? i >= 0 : i < ordered.length;
    i -= direction) {
    const neighbor = i + direction;
    if (selected.has(ordered[i].id) && !selected.has(ordered[neighbor].id)) {
      [ordered[i], ordered[neighbor]] = [ordered[neighbor], ordered[i]];
      moved = true;
    }
  }
  // Normalize ties and gaps only after an actual move; keep the section background at zero.
  return new Map(moved ? ordered.flatMap((card, index) => card.order !== index + 1 ? [[card.id, index + 1] as const] : []) : []);
}
