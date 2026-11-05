import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class PaymentMaintenanceError extends Error {
  constructor(code, summary) { super(code); this.code = code; this.summary = summary; }
}
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function previousChinaDay(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
}
export async function runWechatMaintenance({ mode = "reconcile", date, env = process.env, transport = fetch, now = new Date() } = {}) {
  if (!["reconcile", "bill"].includes(mode) || (mode === "reconcile" && date !== undefined)) throw new PaymentMaintenanceError("INVALID_ARGUMENTS");
  let base;
  try { base = new URL(env.SUPABASE_URL); } catch { throw new PaymentMaintenanceError("INVALID_SUPABASE_URL"); }
  if (base.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(base.hostname) || base.port || base.username || base.password
    || base.pathname !== "/" || base.search || base.hash) throw new PaymentMaintenanceError("INVALID_SUPABASE_URL");
  const token = env.WECHAT_PAY_RECONCILE_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new PaymentMaintenanceError("INVALID_WORKER_TOKEN");
  const billDate = mode === "bill" ? date ?? previousChinaDay(now) : undefined;
  if (billDate !== undefined && (typeof billDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(billDate)
    || !Number.isFinite(Date.parse(`${billDate}T00:00:00Z`)) || new Date(`${billDate}T00:00:00Z`).toISOString().slice(0, 10) !== billDate
    || billDate > previousChinaDay(now))) throw new PaymentMaintenanceError("INVALID_BILL_DATE");
  const url = new URL("/functions/v1/payment-reconcile?forceFunctionRegion=ap-northeast-1", base);
  let response;
  try {
    response = await transport(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(55000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(billDate ? { bill_date: billDate } : {}) });
  } catch { throw new PaymentMaintenanceError("PAYMENT_WORKER_UNAVAILABLE"); }
  if (!response.ok) throw new PaymentMaintenanceError("PAYMENT_WORKER_HTTP_ERROR");
  // Never echo a response body or transport exception: either may contain secrets.
  let result;
  try {
    const reader = response.body?.getReader(); if (!reader) throw new Error();
    const chunks = []; let length = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length;
        if (length > 32768) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new PaymentMaintenanceError("PAYMENT_WORKER_INVALID_RESPONSE"); }
  if (mode === "reconcile") {
    if (!integer(result?.processed) || !integer(result?.failed)) throw new PaymentMaintenanceError("PAYMENT_WORKER_INVALID_RESPONSE");
    const summary = { task: mode, processed: result.processed, failed: result.failed };
    if (summary.failed) throw new PaymentMaintenanceError("PAYMENT_RECONCILIATION_NEEDS_ATTENTION", summary);
    return summary;
  }
  if (result?.bill_date !== billDate || !["matched", "differences"].includes(result.status) || !integer(result.payment_count)
    || !integer(result.refund_count) || !integer(result.difference_count)) throw new PaymentMaintenanceError("PAYMENT_WORKER_INVALID_RESPONSE");
  const summary = { task: mode, bill_date: billDate, status: result.status, payment_count: result.payment_count,
    refund_count: result.refund_count, difference_count: result.difference_count };
  if (summary.status !== "matched" || summary.difference_count) throw new PaymentMaintenanceError("PAYMENT_BILL_NEEDS_ATTENTION", summary);
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 4) throw new PaymentMaintenanceError("INVALID_ARGUMENTS");
    console.log(JSON.stringify({ ok: true, ...await runWechatMaintenance({ mode: process.argv[2] ?? "reconcile", date: process.argv[3] }) }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof PaymentMaintenanceError ? error.code : "PAYMENT_MAINTENANCE_FAILED",
      ...(error instanceof PaymentMaintenanceError && error.summary ? { summary: error.summary } : {}) }));
    process.exitCode = 1;
  }
}
