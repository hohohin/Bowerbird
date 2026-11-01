import { exceedsCanvasDragThreshold, type CanvasPoint } from "./canvasLogic.ts";

export const CANVAS_DRAG_HOLD_MS = 600;

/** One stationary press can become an outgoing drag; movement ends that eligibility. */
export function createCanvasDragHold() {
  let pending: { pointerId: number; point: CanvasPoint } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  return {
    start(pointerId: number, point: CanvasPoint, ready: () => void) {
      cancel();
      const press = { pointerId, point: { ...point } };
      pending = press;
      timer = setTimeout(() => {
        if (pending !== press) return;
        cancel();
        ready();
      }, CANVAS_DRAG_HOLD_MS);
    },
    move(pointerId: number, point: CanvasPoint, buttons = 1) {
      if (pending?.pointerId === pointerId
        && (!(buttons & 1) || exceedsCanvasDragThreshold(pending.point, point))) cancel();
    },
    end(pointerId: number) { if (pending?.pointerId === pointerId) cancel(); },
    cancel,
  };
}
