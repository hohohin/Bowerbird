import { useCallback, useRef, type PointerEvent } from "react";
import { exceedsCanvasDragThreshold, type PreparedCanvasSnapAnchors } from "../../lib/canvasLogic";
import type { canvasDragPreview } from "../../lib/canvasDragPreview";
import type { ProjectCanvasUiNode } from "../../lib/creativeCanvas";
import type { CanvasNode } from "../../lib/types";
import { useCanvasFrame } from "../../lib/useCanvasFrame";
import type { WorkflowGeometry } from "../CanvasWorkflowLayer";

export interface CanvasDrag {
  kind: "material" | "graph";
  nodeId: string;
  toggleSelection: boolean;
  selectedIds: Set<string>;
  initialNodes: ProjectCanvasUiNode[];
  initialGraphNodes: CanvasNode[];
  initialWorkflow: WorkflowGeometry[];
  snapAnchors?: PreparedCanvasSnapAnchors;
  crossedThreshold?: boolean;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  preview?: ReturnType<typeof canvasDragPreview>;
  apply?: () => void;
}

export type CanvasPointerSample = Pick<PointerEvent<HTMLElement>, "pointerId" | "clientX" | "clientY" | "currentTarget">;
export function canvasPointerSample(event: PointerEvent<HTMLElement>): CanvasPointerSample {
  return { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, currentTarget: event.currentTarget };
}

export function clearDragProjection(drag: CanvasDrag | null) {
  if (!drag) return;
  drag.preview?.clear();
  drag.preview = null;
  drag.apply = undefined;
}

export function useCanvasDrag(update: (sample: CanvasPointerSample, kind: CanvasDrag["kind"]) => void) {
  const activeDragRef = useRef<CanvasDrag | null>(null);
  const dragFrame = useCanvasFrame((sample: CanvasPointerSample) => {
    const drag = activeDragRef.current;
    if (drag) update(sample, drag.kind);
  });
  const moveCanvasDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = activeDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.crossedThreshold ||= exceedsCanvasDragThreshold({ x: drag.startClientX, y: drag.startClientY }, { x: event.clientX, y: event.clientY });
    dragFrame.push(canvasPointerSample(event));
  }, [dragFrame]);
  return { activeDragRef, dragFrame, moveCanvasDrag };
}
