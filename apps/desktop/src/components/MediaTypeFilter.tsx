import { Film, Image } from "lucide-react";
import { useStore } from "../store";

export function MediaTypeFilter() {
  const filter = useStore(s => s.mediaFilter);
  const setFilter = useStore(s => s.setMediaFilter);
  return <div className="library-view-control">
    <div className="library-view-segments library-icon-segments" role="group" aria-label="素材类型筛选">
      <button type="button" aria-label="只看图片" aria-pressed={filter === "image"}
        title="只看图片；再点一次显示全部类型" onClick={() => setFilter(filter === "image" ? null : "image")}>
        <Image size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="只看视频" aria-pressed={filter === "video"}
        title="只看视频；再点一次显示全部类型" onClick={() => setFilter(filter === "video" ? null : "video")}>
        <Film size={14} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
