import type { ImgHTMLAttributes } from "react";
import { isVideoPath } from "../lib/videoGeneration";
import { VideoPoster } from "./VideoPoster";
import { FileText, Music2 } from "lucide-react";
import { isAudioPath } from "../lib/audioMedia";
import { isTextPath } from "../lib/textMedia";
import type { Asset } from "../lib/types";
import { AudioWaveform } from "./AudioWaveform";

/** Passive previews never instantiate a player; their parent opens the original on click. */
export function MediaPreview({ src, alt, className, style, onContextMenu, playback = false, videoPath, asset, ...props }: ImgHTMLAttributes<HTMLImageElement> & { playback?: boolean; videoPath?: string | null; asset?: Asset }) {
  if (isTextPath(asset?.store_path ?? src)) return <span role="img" aria-label={alt || "文本"} className={className} style={style}><FileText size={28}/></span>;
  if (isAudioPath(asset?.store_path ?? src)) {
    if (playback && asset?.store_path) return <AudioWaveform assetId={asset.id} path={asset.store_path} name={asset.name}
      version={`${asset.file_mtime ?? 0}:${asset.size ?? 0}`} duration={asset.duration} className={className}/>;
    return <span role="img" aria-label={alt || "音频"} className={className} style={style}><Music2 size={28}/></span>;
  }
  if (playback && isVideoPath(src)) return <video src={src} controls preload="none" playsInline
    aria-label={alt || "视频预览"} className={className} style={style}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()} />;
  if (isVideoPath(src)) return <VideoPoster path={videoPath} alt={alt || "视频"} className={className} style={style} onContextMenu={onContextMenu} {...props} />;
  return <img src={src} alt={alt} className={className} style={style} onContextMenu={onContextMenu} {...props} />;
}
