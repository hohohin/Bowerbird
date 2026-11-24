import { ArrowLeft } from "lucide-react";
import "./EnhancedReplication.css";

export function LibraryVideoReplication({ onBack }: { onBack: () => void }) {
  return <section aria-label="强化复刻">
    <button type="button" className="asset-detail-back" onClick={onBack}>
      <ArrowLeft size={15} aria-hidden="true"/>返回分析
    </button>
    <h3 className="mt-4 text-base font-medium">强化复刻</h3>
    <div className="vr-enhanced">
      <ol className="vre-steps" aria-label="强化复刻流程">
        <li>分析原片</li>
        <li>编辑分镜</li>
        <li>生成成片</li>
      </ol>
    </div>
    <p role="status" className="text-xs text-muted">强化复刻暂未开放</p>
  </section>;
}
