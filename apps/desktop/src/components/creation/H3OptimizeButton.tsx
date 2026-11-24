import { Coins, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import "./H3OptimizeButton.css";

/** Same text-editing action in the composer and the H3 card; billing stays explicit. */
export function H3OptimizeButton({ disabled, busy = false, busyLabel, onClick, iconOnly, repeat }: {
  disabled?: boolean; busy?: boolean; busyLabel?: string; onClick: () => void; iconOnly?: boolean; repeat?: boolean;
}) {
  const Icon = busy ? LoaderCircle : repeat ? RefreshCw : Sparkles;
  const label = repeat ? "重新优化提示词" : "优化提示词";
  return <button type="button" className="h3-optimize-action" disabled={disabled || busy} onClick={onClick}
    aria-label={busy ? busyLabel ?? "正在优化…" : label} aria-busy={busy}
    title={label + " · 消耗 Bowerbird 积分。点击后由 Cloud DSH 优化当前原文。"}>
    <Icon size={14} aria-hidden="true" />{!iconOnly && <><span>{busy ? busyLabel ?? "优化中" : label}</span><Coins size={12} aria-label="消耗 Bowerbird 积分" /></>}
  </button>;
}
