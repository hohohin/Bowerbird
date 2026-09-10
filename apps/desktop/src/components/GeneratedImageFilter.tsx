import { EyeOff, Sparkles } from "lucide-react";
import { useStore } from "../store";

export function GeneratedImageFilter() {
  const smartFilter = useStore((s) => s.smartFilter);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  return <div className="library-view-control">
    <span>生成图</span>
    <div className="library-view-segments" role="group" aria-label="生成图显示模式">
      <button type="button" aria-pressed={smartFilter === "source:generated"}
        title="只看生成图；再点一次显示全部"
        onClick={() => setSmartFilter(smartFilter === "source:generated" ? null : "source:generated")}>
        <Sparkles size={13} /><span>只看</span>
      </button>
      <button type="button" aria-pressed={smartFilter === "source:!generated"}
        title="不看生成图；再点一次显示全部"
        onClick={() => setSmartFilter(smartFilter === "source:!generated" ? null : "source:!generated")}>
        <EyeOff size={13} /><span>不看</span>
      </button>
    </div>
  </div>;
}
