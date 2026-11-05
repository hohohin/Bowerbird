import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { CheckoutOrder } from "../lib/types";
import { ModalShell } from "./ModalShell";

export function CheckoutDialog({ order, account, busy, error, onClose, onQuery, onRetry }: {
  order: CheckoutOrder | null; account: string; busy: boolean; error: string;
  onClose: () => void; onQuery: () => void; onRetry: () => void;
}) {
  const [qr, setQr] = useState("");
  const [qrError, setQrError] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    let active = true;
    setQr(""); setQrError(false);
    if (order?.code_url) void QRCode.toDataURL(order.code_url, { width: 240, margin: 4, errorCorrectionLevel: "M", color: { dark: "#141414", light: "#ffffff" } })
      .then(value => { if (active) setQr(value); }).catch(() => { if (active) setQrError(true); });
    return () => { active = false; };
  }, [order?.code_url]);
  const seconds = order ? Math.max(0, Math.ceil((Date.parse(order.expires_at) - now) / 1000)) : 0;
  const pending = order?.status === "pending";
  const status = !order ? "正在确认订单" : ({ pending: seconds > 0 ? (order.code_url ? "请用微信扫一扫付款" : "正在确认订单") : "支付时间已到，正在核对结果",
    paid: "支付成功", closed: "订单已关闭", refunding: "退款处理中", refunded: "已退款" }[order.status]);
  return <ModalShell title="微信支付" className="account-checkout-dialog" onClose={onClose}
    panelProps={{ onKeyDown: event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } } }}
    footer={<>
      {(!order || pending) && <button className="app-modal-button" disabled={busy} onClick={order ? onQuery : onRetry}>{busy ? "查询中…" : order ? "查询支付结果" : "重试原请求"}</button>}
      <button className="app-modal-button" onClick={onClose}>{order?.status === "paid" ? "完成" : "关闭"}</button>
    </>}>
    <div className="account-checkout-content" aria-busy={busy}>
      <p className="account-checkout-account">{account}</p>
      {order && <><p>{order.months ? `Pro · ${order.months === 12 ? "年付" : "月付"}` : `${order.credits.toLocaleString("zh-CN")} Bcoin`}</p>
        <strong className="account-checkout-price">¥{(order.amount_minor / 100).toFixed(2)}</strong></>}
      {pending && seconds > 0 && order.code_url && <div className="account-checkout-qr">{qr ? <img src={qr} alt="微信付款二维码" width={240} height={240} /> : <span>{qrError ? "二维码暂时无法显示，请重新打开订单" : "正在生成二维码…"}</span>}</div>}
      <p role="status">{status}</p>
      {pending && seconds > 0 && <p className="account-billing-note">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} 内完成付款</p>}
      {error && <p role="alert" className="account-billing-note is-error">{error}</p>}
    </div>
  </ModalShell>;
}
