import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasPoint } from "../../lib/canvasLogic";
import type { canvasPaintWindow } from "../../lib/canvasPaintWindow";
import { useCanvasFrame } from "../../lib/useCanvasFrame";

export function useCanvasCamera({
  projectId, viewMode, prioritize, repaintGesture, scheduleViewSave, cancelViewSave,
}: {
  projectId: string | null;
  viewMode: string;
  prioritize: (pan: CanvasPoint, zoom: number) => void;
  repaintGesture: () => void;
  scheduleViewSave: () => void;
  cancelViewSave: () => void;
}) {
  const [pan, setPan] = useState<CanvasPoint>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const wheelStageRect = useRef<DOMRect>();
  const gridElement = useRef<HTMLDivElement>(null);
  const paintWindow = useRef<ReturnType<typeof canvasPaintWindow> | null>(null);
  const mediaZoomHandle = useRef<((value: number) => void) | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const centeredEditorRef = useRef<HTMLElement | null>(null);
  const editorCenterFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const stop = () => { if (editorCenterFrameRef.current != null) settleCamera(); };
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("blur", stop);
      cancelEditorCenter();
      centeredEditorRef.current = null;
    };
  }, [projectId, viewMode]);
  const cameraSettleRef = useRef<ReturnType<typeof setTimeout>>();
  const cameraFrame = useCanvasFrame<void>(() => {
    paintCamera();
    repaintGesture();
    clearTimeout(cameraSettleRef.current);
    cameraSettleRef.current = setTimeout(settleCamera, 120);
  });
  const readCanvasZoom = useCallback(() => { cameraFrame.flush(); return zoomRef.current; }, [cameraFrame]);
  const toBoardPoint = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  function paintCamera() {
    wheelStageRect.current = undefined;
    const currentPan = panRef.current;
    const currentZoom = zoomRef.current;
    prioritize(currentPan, currentZoom);
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
    scheduleViewSave();
  }

  function scheduleCamera() {
    cameraFrame.push();
    clearTimeout(cameraSettleRef.current);
    cancelViewSave();
  }

  return {
    pan, setPan, zoom, setZoom, panRef, zoomRef, stageRef, planeRef, gridElement, zoomLabelRef,
    centeredEditorRef, editorCenterFrameRef, cameraSettleRef, paintWindow, mediaZoomHandle, wheelStageRect,
    cameraFrame, paintCamera, settleCamera, scheduleCamera, cancelEditorCenter, readCanvasZoom, toBoardPoint,
  };
}
