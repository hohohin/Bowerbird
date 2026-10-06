import type { ImgHTMLAttributes } from "react";
import { isVideoPath } from "../lib/videoGeneration";
import { VideoPoster } from "./VideoPoster";

/** Passive previews never instantiate a player; their parent opens the original on click. */
export function MediaPreview({ src, alt, className, style, onContextMenu, playback = false, videoPath, ...props }: ImgHTMLAttributes<HTMLImageElement> & { playback?: boolean; videoPath?: string | null }) {
  if (playback && isVideoPath(src)) return <video src={src} controls preload="none" playsInline
    aria-label={alt || "视频预览"} className={className} style={style}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()} />;
  if (isVideoPath(src)) return <VideoPoster path={videoPath} alt={alt || "视频"} className={className} style={style} onContextMenu={onContextMenu} {...props} />;
  return <img src={src} alt={alt} className={className} style={style} onContextMenu={onContextMenu} {...props} />;
}
