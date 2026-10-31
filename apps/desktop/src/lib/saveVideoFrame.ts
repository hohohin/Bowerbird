import { api } from "./api";
import { videoTime, type VideoFrame } from "./videoFrame";

/** The caller freezes the destination before starting any asynchronous work. */
export function saveVideoFrame(frame: VideoFrame, projectId: string | null) {
  return api.importImageBytes({ dataUrl: frame.dataUrl, projectId, source: "video-frame",
    fileName: `${frame.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "视频"}-${videoTime(frame.time).replace(/:/g, "-")}.png`,
    videoFrame: { sourcePath: frame.path, time: frame.time } });
}
