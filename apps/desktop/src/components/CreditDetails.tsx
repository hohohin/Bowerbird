import type { EntitlementSnapshot } from "../lib/types";
import { creditTransactionView } from "../lib/creditHistory";

export function CreditDetails({ entitlement }: { entitlement: EntitlementSnapshot | null }) {
  const balances = entitlement?.balances;
  const transactions = entitlement?.recent_transactions ?? [];
  const rows = transactions.slice(0, 50).map(creditTransactionView).filter(view => view !== null);
  return <section aria-label="积分明细">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-ink">积分明细</h3>
      <span className="text-xs text-muted">可用余额 <strong className="text-ink">{balances ? (balances.daily + balances.sub + balances.topup).toLocaleString("zh-CN") : "—"}</strong> Bcoin</span>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
      {([['赠送积分', balances ? balances.daily + balances.sub : null], ['充值积分', balances?.topup]] as const).map(([label, amount]) => <div key={label} className="rounded-lg border border-edge bg-canvas/70 p-2">
        <div className="text-muted">{label}</div><div className="mt-1 font-semibold tabular-nums text-ink">{amount?.toLocaleString("zh-CN") ?? "—"}</div>
      </div>)}
    </div>
    <div className="mt-3 border-t border-edge pt-3">
      <p className="text-xs text-muted">近期收支</p>
      {!entitlement ? <p className="mt-3 text-xs text-muted">积分信息暂不可用，请刷新权益后重试。</p>
        : rows.length === 0 ? <p className="mt-3 text-xs text-muted">暂无积分收支</p>
        : <ul className="mt-1 divide-y divide-edge" aria-label="最近积分记录">
          {rows.map((view, index) => {
            return <li key={`${view.time}-${index}`} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-xs font-medium text-ink">{view.title}</p>
                <span className={`shrink-0 text-xs font-medium tabular-nums ${view.direction === "in" ? "text-accent" : "text-ink"}`}>{view.amount}</span>
              </div>
              <p className="mt-1 text-xs text-muted">{view.time}</p>
            </li>;
          })}
        </ul>}
    </div>
  </section>;
}
