import { Coins, LoaderCircle, Sparkles } from "lucide-react";
import "./H3OptimizeButton.css";

/** Same text-editing action in the composer and the H3 card; billing stays explicit. */
export function H3OptimizeButton({ disabled, busy = false, onClick }: { disabled?: boolean; busy?: boolean; onClick: () => void }) {
  const Icon = busy ? LoaderCircle : Sparkles;
  return <button type="button" className="h3-optimize-action" disabled={disabled || busy} onClick={onClick}
    aria-label={busy ? "正在优化…" : "优化提示词"} aria-busy={busy}
    title="优化提示词 · 消耗 Bowerbird 积分。点击才调用 Cloud DSH，不自动生成视频。">
    <Icon size={14} aria-hidden="true" /><span>{busy ? "优化中" : "优化提示词"}</span><Coins size={12} aria-label="消耗 Bowerbird 积分" />
  </button>;
}
