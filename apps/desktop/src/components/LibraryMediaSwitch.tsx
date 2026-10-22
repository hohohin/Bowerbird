import { Image, Video } from "lucide-react";
import { useLocalFileMode } from "../lib/localFileMode";

export function LibraryMediaSwitch() {
  const media = useLocalFileMode(s => s.media);
  return <div className="library-media-switch library-floating-surface" role="group" aria-label="素材类型">
    {(["images", "videos"] as const).map(value => <button key={value} aria-label={value === "images" ? "图片" : "视频"}
      aria-pressed={media === value} title={value === "images" ? "浏览图片" : "浏览视频"}
      onClick={() => useLocalFileMode.getState().setMedia(value)}>
      {value === "images" ? <Image size={14} aria-hidden="true"/> : <Video size={14} aria-hidden="true"/>}
    </button>)}
  </div>;
}
