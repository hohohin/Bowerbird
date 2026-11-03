import type { VideoFrame } from "./videoFrame";

export const VIDEO_FRAME_CANVAS_EVENT = "bowerbird:save-video-frame-to-canvas";
export interface VideoFrameCanvasDetail {
  frame: VideoFrame;
  projectId: string;
  result?: Promise<void>;
}

/** Canvas owns the save journal, frozen project and retry identity. */
export function saveVideoFrameToCanvas(frame: VideoFrame, projectId: string) {
  const detail: VideoFrameCanvasDetail = { frame, projectId };
  window.dispatchEvent(new CustomEvent(VIDEO_FRAME_CANVAS_EVENT, { detail }));
  return detail.result ?? Promise.reject(new Error("目标画板尚未就绪，请返回画板后重试"));
}
