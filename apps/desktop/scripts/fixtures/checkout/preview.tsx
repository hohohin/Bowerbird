import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountBilling } from "../../../src/components/AccountBilling";
import { AccountOnboarding } from "../../../src/components/AccountOnboarding";
import { useStore } from "../../../src/store";

const w = window as any;
w.calls = []; w.enabled = false; w.orders = {}; w.mode = "success";
const free: any = { user_id: "user-a", tier: "free", balances: { daily: 0, sub: 200, topup: 0 }, policy: {}, recent_transactions: [], generation_services: [], prompt_configs: [] };
w.switchAccount = (id: string) => useStore.setState({ cloudAuth: { cloud_available: true, logged_in: true, user_id: id, email: `${id}@example.test`, display_name: id, avatar_url: null, access_expires_at: null, reason: null }, cloudEntitlement: { ...free, user_id: id } });
w.switchAccount("user-a");
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
let callbackId = 0;
w.__TAURI_INTERNALS__ = {
  transformCallback: () => ++callbackId,
  unregisterCallback() {},
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") return;
    if (command === "cloud_checkout_capability") return { enabled: w.enabled, provider: "wechatpay", custom_max_yuan: 21474836 };
    if (command === "cloud_checkout_status") {
      if (w.mode === "query-error") throw "query failed: https://private.example/api";
      const rows = Object.values(w.orders) as any[];
      return { order: rows.find(o => o.user === args.userId && (args.orderId ? o.order_id === args.orderId : o.status === "pending")) ?? null };
    }
    if (command === "cloud_sync_entitlement") return { ...free, user_id: useStore.getState().cloudAuth!.user_id, tier: "pro", balances: { daily: 0, sub: 1000, topup: 0 } };
    if (command === "cloud_create_checkout") {
      const request = args.request;
      if (w.mode === "hold") await new Promise(resolve => { w.release = resolve; });
      const previous: any = Object.values(w.orders).find((o: any) => o.user === args.userId && o.key === request.idempotency_key);
      const order = previous ?? { order_id: crypto.randomUUID(), provider: "wechatpay", product: request.product,
        amount_minor: request.product === "bcoin_custom" ? request.custom_amount_yuan * 100 : request.product === "pro_yearly" ? 35900 : request.product === "pro_monthly" ? 3900 : 2000,
        credits: request.product === "bcoin_custom" ? request.custom_amount_yuan * 20 : request.product.startsWith("pro") ? 0 : 400,
        months: request.product === "pro_yearly" ? 12 : request.product === "pro_monthly" ? 1 : 0,
        currency: "CNY", status: "pending", code_url: "weixin://wxpay/bizpayurl?pr=synthetic", expires_at: new Date(Date.now() + 900000).toISOString(), user: args.userId, key: request.idempotency_key };
      w.orders[order.order_id] = order;
      if (w.mode === "lost") throw "connection dropped";
      return { order };
    }
    throw new Error(`Unexpected IPC ${command}`);
  },
};
function Preview() {
  const [version, setVersion] = useState(0);
  w.remount = () => setVersion(n => n + 1);
  const auth = useStore(s => s.cloudAuth);
  const entitlement = useStore(s => s.cloudEntitlement);
  if (new URLSearchParams(location.search).has("standalone")) return <AccountOnboarding key={version} />;
  return <main style={{ maxWidth: 640, margin: "20px auto" }}><AccountBilling key={`${auth?.user_id}-${version}`} loggedIn={!!auth?.logged_in} entitlement={entitlement} /></main>;
}
w.store = useStore;
createRoot(document.getElementById("root")!).render(<Preview />);
