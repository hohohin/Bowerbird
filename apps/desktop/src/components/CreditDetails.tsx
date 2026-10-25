import type { EntitlementSnapshot } from "../lib/types";
import { creditTransactionView } from "../lib/creditHistory";

export function CreditDetails({ entitlement }: { entitlement: EntitlementSnapshot | null }) {
  const balances = entitlement?.balances;
  const transactions = entitlement?.recent_transactions ?? [];
  return <section aria-label="积分明细">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-ink">积分明细</h3>
      <span className="text-xs text-muted">可用余额 <strong className="text-ink">{balances ? (balances.daily + balances.sub + balances.topup).toLocaleString("zh-CN") : "—"}</strong> Bcoin</span>
    </div>
    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
      {([['daily', '历史每日赠送'], ['sub', '历史赠送积分'], ['topup', '充值积分']] as const).map(([key, label]) => <div key={key} className="rounded-lg border border-edge bg-canvas/70 p-2">
        <div className="text-muted">{label}</div><div className="mt-1 font-semibold tabular-nums text-ink">{balances?.[key]?.toLocaleString("zh-CN") ?? "—"}</div>
      </div>)}
    </div>
    <details className="mt-3 text-xs leading-5 text-muted">
      <summary className="cursor-pointer text-ink">如何看懂积分记录</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li>任务开始时先预留积分；结算完成不会再扣一次，多余预留会单独返还。</li>
        <li>任务失败或取消后，退回金额以实际记录为准；尚未结算时不代表已退款。</li>
        <li>“＋”表示余额增加，“−”表示余额减少，“余额不变”仅记录结算。</li>
        <li>同一任务可能分多条记录；这里只显示最近 50 条，不代表完整账单。</li>
      </ul>
    </details>
    <div className="mt-3 border-t border-edge pt-3">
      <p className="text-xs text-muted">最近记录 · 按时间倒序</p>
      {!entitlement ? <p className="mt-3 text-xs text-muted">积分信息暂不可用，请刷新权益后重试。</p>
        : transactions.length === 0 ? <p className="mt-3 text-xs text-muted">暂无积分记录</p>
        : <ul className="mt-1 divide-y divide-edge" aria-label="最近积分记录">
          {transactions.slice(0, 50).map((tx, index) => {
            const view = creditTransactionView(tx);
            return <li key={`${tx.created_at}-${index}`} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="text-xs font-medium text-ink">{view.title}</p><p className="mt-1 break-words text-xs text-muted">{view.usage}{view.status ? ` · ${view.status}` : ""}</p></div>
                <span className={`shrink-0 text-xs font-medium tabular-nums ${view.direction === "in" ? "text-accent" : "text-ink"}`}>{view.amount}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">{view.description}</p>
              <p className="mt-1 text-xs text-muted">{view.time}</p>
            </li>;
          })}
        </ul>}
    </div>
  </section>;
}
