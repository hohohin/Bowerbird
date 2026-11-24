import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { useCanvasFrame } from "../lib/useCanvasFrame";
import { clampCanvasZoom, type CanvasPoint, type CanvasRect } from "../lib/canvasLogic";
import { canvasPaintWindow } from "../lib/canvasPaintWindow";

interface ViewportOptions {
  projectId: string | null;
  onPaint(pan: CanvasPoint, zoom: number): void;
  onCameraFrame(): void;
  markViewDirty(notify?: boolean): void;
  scheduleViewSave(): void;
  getContentBounds(): CanvasRect[];
}

export function useCanvasViewport({ projectId, onPaint, onCameraFrame, markViewDirty, scheduleViewSave, getContentBounds }: ViewportOptions) {
  const [pan, setPan] = useState<CanvasPoint>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  // Gesture frames own the live camera until the next React layout commit.
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const gridElement = useRef<HTMLDivElement>(null);
  const wheelStageRect = useRef<DOMRect | undefined>(undefined);
  const paintWindow = useRef<ReturnType<typeof canvasPaintWindow> | null>(null);
  const cameraSettleRef = useRef<ReturnType<typeof setTimeout>>();
  const centeredEditorRef = useRef<HTMLElement | null>(null);
  const editorCenterFrameRef = useRef<number | null>(null);
  const mediaZoomHandle = useRef<((value: number) => void) | null>(null);
  const viewSaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const cameraFrame = useCanvasFrame<void>(() => {
    paintCamera();
    onCameraFrame();
    clearTimeout(cameraSettleRef.current);
    cameraSettleRef.current = setTimeout(settleCamera, 120);
  });
  const readCanvasZoom = useCallback(() => { cameraFrame.flush(); return zoomRef.current; }, [cameraFrame]);

  function paintCamera() {
    wheelStageRect.current = undefined;
    const currentPan = panRef.current;
    const currentZoom = zoomRef.current;
    onPaint(currentPan, currentZoom);
    if (planeRef.current) {
      paintWindow.current?.paint(currentPan, currentZoom);
      planeRef.current.style.transform = `translate3d(${currentPan.x}px, ${currentPan.y}px, 0) scale(${currentZoom})`;
    }
    if (stageRef.current) {
      // The industrial grid repeats every 80 screen pixels. Pan its own layer
      // without repainting the stage or invalidating inherited styles on every card.
      if (gridElement.current) gridElement.current.style.transform = `translate3d(${currentPan.x % 80}px,${currentPan.y % 80}px,0)`;
    }
    const label = `${Math.round(currentZoom * 100)}%`;
    if (zoomLabelRef.current && zoomLabelRef.current.textContent !== label) zoomLabelRef.current.textContent = label;
  }

  function cancelEditorCenter() {
    if (editorCenterFrameRef.current != null) cancelAnimationFrame(editorCenterFrameRef.current);
    editorCenterFrameRef.current = null;
  }

  function settleCamera() {
    cancelEditorCenter();
    clearTimeout(cameraSettleRef.current);
    cameraFrame.cancel();
    paintCamera();
    mediaZoomHandle.current?.(zoomRef.current);
    if (stageRef.current) {
      stageRef.current.style.backgroundPosition = `${panRef.current.x}px ${panRef.current.y}px`;
      stageRef.current.style.backgroundSize = `${72 * zoomRef.current}px ${72 * zoomRef.current}px`;
    }
    scheduleViewSave();
  }

  function scheduleCamera() {
    cameraFrame.push();
    clearTimeout(cameraSettleRef.current);
    clearTimeout(viewSaveTimer.current);
  }

  const toBoardPoint = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  function zoomAround(clientX: number, clientY: number, requested: number, rect = stageRef.current?.getBoundingClientRect()) {
    if (!rect) return;
    const nextZoom = clampCanvasZoom(requested);
    const point = { x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current };
    const nextPan = {
      x: clientX - rect.left - point.x * nextZoom,
      y: clientY - rect.top - point.y * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    markViewDirty(false);
    scheduleCamera();
  }

  function onCanvasWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(event.clientX, event.clientY, zoomRef.current * Math.exp(-event.deltaY * 0.0015),
        wheelStageRect.current ??= event.currentTarget.getBoundingClientRect());
    } else {
      const next = { x: panRef.current.x - event.deltaX, y: panRef.current.y - event.deltaY };
      panRef.current = next;
      markViewDirty(false);
      scheduleCamera();
    }
  }

  function fitCanvas() {
    const stage = stageRef.current;
    const content = getContentBounds();
    if (!stage || content.length === 0) {
      panRef.current = { x: 0, y: 0 };
      zoomRef.current = 1;
      setPan({ x: 0, y: 0 });
      setZoom(1);
      markViewDirty();
      return;
    }
    const bounds = content.reduce(
      (acc, node) => ({
        left: Math.min(acc.left, node.x),
        top: Math.min(acc.top, node.y),
        right: Math.max(acc.right, node.x + node.width),
        bottom: Math.max(acc.bottom, node.y + node.height),
      }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const rect = stage.getBoundingClientRect();
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const nextZoom = clampCanvasZoom(Math.min(1, (rect.width - 120) / width, (rect.height - 120) / height));
    const nextPan = {
      x: (rect.width - width * nextZoom) / 2 - bounds.left * nextZoom,
      y: (rect.height - height * nextZoom) / 2 - bounds.top * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
    markViewDirty();
  }

  useEffect(() => () => {
    clearTimeout(cameraSettleRef.current);
    cameraFrame.cancel();
  }, [projectId, cameraFrame]);
  return {
    setPan, setZoom, panRef, zoomRef, stageRef, planeRef, zoomLabelRef, gridElement, paintWindow,
    viewSaveTimer, mediaZoomHandle, centeredEditorRef, editorCenterFrameRef, cameraSettleRef, cameraFrame,
    readCanvasZoom, paintCamera, settleCamera, cancelEditorCenter, toBoardPoint, zoomAround, onCanvasWheel, fitCanvas,
  };
}
