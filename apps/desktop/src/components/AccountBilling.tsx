import { useId, useState, type ReactNode } from "react";
import { Check, Coins, Sparkles } from "lucide-react";
import type { EntitlementSnapshot } from "../lib/types";
import { useStore } from "../store";
import { useCheckout } from "./useCheckout";
import { CheckoutDialog } from "./CheckoutDialog";
import "./AccountBilling.css";

const TOPUP_AMOUNTS = [5, 10, 20, 50, 100, 500] as const;
const PLANS = [
  { id: "monthly", title: "月付", price: 39, duration: "1 个月", detail: "按月选择，灵活使用" },
  { id: "yearly", title: "年付", price: 359, duration: "12 个月", detail: "折合 ¥29.92 / 月" },
] as const;
const PLAN_FEATURES = [
  { name: "素材管理与普通画布", free: "支持", pro: "支持" },
  { name: "Cloud 服务", free: "按量扣 Bcoin", pro: "按量扣 Bcoin" },
  { name: "自有订阅接入", free: "不支持", pro: "支持" },
  { name: "工作流卡片", free: "不支持", pro: "支持" },
  { name: "本地生成", free: "不支持", pro: "支持" },
] as const;
const formatNumber = (value: number) => value.toLocaleString("zh-CN");

export function AccountBilling({ loggedIn, entitlement, trialAction }: {
  loggedIn: boolean;
  entitlement: EntitlementSnapshot | null;
  trialAction?: ReactNode;
}) {
  const id = useId();
  const [plan, setPlan] = useState<"monthly" | "yearly">("monthly");
  const [topup, setTopup] = useState<number | "custom">(20);
  const [custom, setCustom] = useState("");
  const [customTouched, setCustomTouched] = useState(false);
  const auth = useStore(s => s.cloudAuth);
  const checkout = useCheckout(loggedIn ? auth?.user_id ?? null : null);
  const needsRefresh = entitlement?.offline_state === "expired" || entitlement?.offline_state === "invalid";
  const current = loggedIn && !needsRefresh ? entitlement : null;
  const tierName = current ? { free: "Free", pro: "Pro", studio: "Studio" }[current.tier] : null;
  const status = !loggedIn ? "登录后查看方案" : needsRefresh ? "权益需刷新" : tierName ? `当前方案 · ${tierName}` : "权益暂不可用";
  const balance = current ? current.balances.daily + current.balances.sub + current.balances.topup : null;
  const selectedPlan = PLANS.find((item) => item.id === plan)!;
  const customAmount = Number(custom.trim());
  const validCustom = /^\d+$/.test(custom.trim()) && customAmount > 0 && customAmount <= checkout.maxAmount
    && Number.isSafeInteger(customAmount * 100) && Number.isSafeInteger(customAmount * 20);
  const amount = topup === "custom" ? (validCustom ? customAmount : null) : topup;
  const customError = customTouched && !validCustom;

  return (
    <div className="account-billing">
      <section aria-label="Plan" className="settings-card account-billing-section">
        <div className="account-billing-heading">
          <div className="account-billing-title"><Sparkles size={16} aria-hidden="true" /><h3>Plan</h3><span>功能订阅</span></div>
          <span className="account-billing-status">{status}</span>
        </div>
        <table aria-label="Free 与 Pro 功能对比" className="account-billing-comparison">
          <thead><tr><th scope="col">功能</th><th scope="col">Free<span>免费使用</span></th><th scope="col">Pro<span>功能订阅</span></th></tr></thead>
          <tbody>{PLAN_FEATURES.map((feature) => <tr key={feature.name}>
            <th scope="row">{feature.name}</th>
            <td>{feature.free}</td>
            <td>{feature.pro}</td>
          </tr>)}</tbody>
        </table>
        <fieldset className="account-billing-plans">
          <legend className="sr-only">Pro 付费周期</legend>
          {PLANS.map((item) => (
            <label key={item.id} className={`account-billing-option account-billing-plan${plan === item.id ? " is-selected" : ""}`}>
              <input type="radio" name={`${id}-plan`} value={item.id} checked={plan === item.id} onChange={() => setPlan(item.id)} aria-label={`Pro ${item.title} ¥${item.price}`} />
              <span className="account-billing-option-heading"><span>{item.title}</span><Check className="account-billing-check" size={14} aria-hidden="true" /></span>
              <span className="account-billing-price">¥{item.price}<small> / {item.duration}</small></span>
              <span className="account-billing-note">{item.detail}</span>
              {item.id === "yearly" && <span className="account-billing-saving">省 ¥109 / 年</span>}
            </label>
          ))}
        </fieldset>
        <p className="account-billing-note">新注册账号赠 200 Bcoin；新订阅或续费 Pro，每订阅月赠 800 Bcoin，年付分 12 次发放。赠送积分到账后 30 天有效。</p>
        <div className="account-billing-checkout">
          <div className="account-billing-summary" aria-live="polite"><span>Pro {selectedPlan.title}</span><strong>¥{selectedPlan.price}</strong></div>
          <button type="button" className="app-modal-button" disabled={!checkout.enabled || checkout.busy || checkout.restoring || checkout.recoveryFailed || current?.tier === "studio"} onClick={() => void checkout.begin(`pro_${plan}`)} aria-describedby={`${id}-plan-payment`}>{checkout.busy ? "正在处理…" : checkout.enabled ? "微信支付" : "购买暂未开放"}</button>
        </div>
        <p id={`${id}-plan-payment`} className="account-billing-note">
          {current?.tier === "studio" && "当前 Studio 权益继续保留。"}
          {!loggedIn && "登录后可查看账号权益。"}
          {checkout.enabled ? "一次购买对应所选周期，不自动扣款。" : "微信支付尚未开放。已有兑换码可在账号管理中兑换。"}
        </p>
        {trialAction && <div className="account-billing-trial">{trialAction}</div>}
      </section>

      <section aria-label="Bcoin 充值" className="settings-card account-billing-section">
        <div className="account-billing-heading">
          <div className="account-billing-title"><Coins size={16} aria-hidden="true" /><h3>Bcoin</h3><span>按量充值</span></div>
          <span className="account-billing-exchange">¥1 = 20 Bcoin</span>
        </div>
        <div className="account-billing-balance">
          <div><span className="account-billing-note">可用余额</span><div className="account-billing-balance-value">{balance === null ? "—" : formatNumber(balance)} <small>Bcoin</small></div></div>
          <p className="account-billing-note account-billing-terms">充值 Bcoin 长期有效<br />Free / Pro 充值价格相同</p>
        </div>
        <fieldset className="account-billing-topups">
          <legend className="sr-only">充值金额</legend>
          <div className="account-billing-topup-options">
          {TOPUP_AMOUNTS.map((value) => (
            <label key={value} className={`account-billing-option${topup === value ? " is-selected" : ""}`}>
              <input type="radio" name={`${id}-topup`} value={value} checked={topup === value} onChange={() => setTopup(value)} aria-label={`充值 ¥${value}，${formatNumber(value * 20)} Bcoin`} />
              <span className="account-billing-option-heading"><strong>¥{value}</strong><Check className="account-billing-check" size={12} aria-hidden="true" /></span>
            </label>
          ))}
          <label className={`account-billing-option${topup === "custom" ? " is-selected" : ""}`}>
            <input type="radio" name={`${id}-topup`} value="custom" checked={topup === "custom"} onChange={() => setTopup("custom")} aria-label="自定义充值金额" />
            <span className="account-billing-option-heading"><span>自定义</span><Check className="account-billing-check" size={12} aria-hidden="true" /></span>
          </label>
          </div>
        </fieldset>
        {topup === "custom" && <div className="account-billing-custom">
          <label htmlFor={`${id}-custom`}>自定义充值金额（元）</label>
          <div className="account-billing-input"><span aria-hidden="true">¥</span><input id={`${id}-custom`} className="app-form-input" type="text" inputMode="numeric" placeholder="输入整数金额" value={custom} onChange={(event) => setCustom(event.target.value)} onBlur={() => setCustomTouched(true)} aria-invalid={customError} aria-describedby={`${id}-custom-help`} /></div>
          <p id={`${id}-custom-help`} className={`account-billing-note${customError ? " is-error" : ""}`} role={customError ? "alert" : undefined}>{customError ? `请输入 1 至 ${formatNumber(checkout.maxAmount)} 之间的整数金额。` : "输入整数元，按 ¥1 = 20 Bcoin 换算。"}</p>
        </div>}
        <div className="account-billing-checkout">
          <div className="account-billing-topup-summary" aria-live="polite" aria-atomic="true">
            <span>支付 <strong>{amount === null ? "—" : `¥${formatNumber(amount)}`}</strong></span>
            <span>到账 <output aria-label="充值到账 Bcoin">{amount === null ? "—" : formatNumber(amount * 20)}</output> Bcoin</span>
          </div>
          <button type="button" className="app-modal-button" disabled={!checkout.enabled || checkout.busy || checkout.restoring || checkout.recoveryFailed || amount === null} onClick={() => void checkout.begin(topup === "custom" ? "bcoin_custom" : `bcoin_${topup * 20}`, topup === "custom" ? amount! : undefined)} aria-describedby={`${id}-topup-payment`}>{checkout.busy ? "正在处理…" : checkout.enabled ? "微信充值" : "充值暂未开放"}</button>
        </div>
        {!checkout.enabled && <p id={`${id}-topup-payment`} className="account-billing-note">{!loggedIn && "登录后可查看账号余额。"}微信支付尚未开放，当前可查看充值金额与到账 Bcoin。</p>}
      </section>
      {checkout.recoveryFailed ? <button className="app-modal-button" disabled={checkout.busy} onClick={() => void checkout.query()}>重试查询订单</button> : checkout.hasAttempt && <button className="app-modal-button" disabled={checkout.busy || checkout.restoring} onClick={() => { checkout.setOpen(true); void checkout.query(); }}>查看待支付订单</button>}
      {checkout.open && <CheckoutDialog order={checkout.order} account={auth?.display_name || auth?.email || auth?.user_id || ""} busy={checkout.busy} error={checkout.error} onClose={() => checkout.setOpen(false)} onQuery={() => void checkout.query()} onRetry={() => void checkout.begin(`pro_${plan}`)} />}
    </div>
  );
}
