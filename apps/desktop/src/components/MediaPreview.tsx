import type { ImgHTMLAttributes } from "react";
import { isVideoPath } from "../lib/videoGeneration";

/** Result/reference paths may be either images or video, including missing posters. */
export function MediaPreview({ src, alt, className, style, onContextMenu, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  if (isVideoPath(src)) return <video src={src} controls preload="metadata" playsInline
    aria-label={alt || "视频预览"} className={className} style={style}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()} />;
  return <img src={src} alt={alt} className={className} style={style} onContextMenu={onContextMenu} {...props} />;
}
