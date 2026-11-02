import { useLibraryModeStore } from "../lib/libraryPane";
import { FileText, Image, Music2, Video } from "lucide-react";

export function LibraryMediaSwitch() {
  const useLocalFileMode = useLibraryModeStore();
  const media = useLocalFileMode(s => s.media);
  return <div className="library-media-switch library-floating-surface" role="group" aria-label="素材类型">
    {(["images", "videos", "audios", "texts"] as const).map(value => <button key={value} aria-label={value === "images" ? "图片" : value === "videos" ? "视频" : value === "texts" ? "文本" : "音频"}
      aria-pressed={media === value} title={value === "images" ? "浏览图片" : value === "videos" ? "浏览视频" : value === "texts" ? "浏览文本" : "浏览音频"}
      onClick={() => useLocalFileMode.getState().setMedia(value)}>
      {value === "images" ? <Image size={14} aria-hidden="true"/> : value === "videos" ? <Video size={14} aria-hidden="true"/> : value === "texts" ? <FileText size={14} aria-hidden="true"/> : <Music2 size={14} aria-hidden="true"/>}
    </button>)}
  </div>;
}
