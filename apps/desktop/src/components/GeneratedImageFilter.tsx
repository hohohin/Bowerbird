import { Sparkles } from "lucide-react";
import { useStore } from "../store";

export function GeneratedImageFilter() {
  const smartFilter = useStore((s) => s.smartFilter);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  return <div className="library-view-control">
    <div className="library-view-segments library-icon-segments" role="group" aria-label="生成图显示模式">
      <button type="button" aria-label="只看生成图" aria-pressed={smartFilter === "source:generated"}
        title="只看生成图；再点一次显示全部"
        onClick={() => setSmartFilter(smartFilter === "source:generated" ? null : "source:generated")}>
        <Sparkles size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="不看生成图" aria-pressed={smartFilter === "source:!generated"}
        title="不看生成图；再点一次显示全部"
        onClick={() => setSmartFilter(smartFilter === "source:!generated" ? null : "source:!generated")}>
        <span className="generated-filter-off" aria-hidden="true"><Sparkles size={14} />
          <svg viewBox="0 0 14 14"><path d="M1 1 13 13" /></svg>
        </span>
      </button>
    </div>
  </div>;
}
