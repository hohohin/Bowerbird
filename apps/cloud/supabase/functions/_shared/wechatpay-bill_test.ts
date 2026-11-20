import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";
import { compareWechatBill, downloadWechatBill, parseWechatTradeBill, reconcileWechatBill, yuanToMinor, type BillRow, type LocalPayment, type LocalRefund } from "./wechatpay-bill.ts";
import type { WechatPayConfig } from "./wechatpay.ts";

const columns = "公众账号ID,商户号,微信订单号,商户订单号,交易状态,货币种类,订单金额,商户退款单号,微信退款单号,申请退款金额,商品名称";
const csv = `${columns}\n\`wx0123456789abcdef,\`1900000001,\`txn1,\`order1,\`SUCCESS,\`CNY,\`39.00,\`0,\`0,\`0,\`"Pro, 月付"\n总交易单数,订单总金额\n\`1,\`39.00\n`;
const config = { mchid: "1900000001", appid: "wx0123456789abcdef" };
const payment: LocalPayment = { order_id: "local-order1", mchid: config.mchid, appid: config.appid, out_trade_no: "order1", transaction_id: "txn1",
  payment_state: "SUCCESS", success_time: "2026-11-03T00:00:00+08:00", orders: { amount_minor: 3900, currency: "CNY", status: "paid" } };

Deno.test("bill decimal yuan conversion is exact, bounded and rejects ambiguous amounts", () => {
  assertEquals(yuanToMinor("0.29"), 29); assertEquals(yuanToMinor("1234.1"), 123410);
  for (const value of ["-1", "1.001", "1e5", "NaN", "", "9007199254740992"]) assertThrows(() => yuanToMinor(value));
});
Deno.test("ALL bill reads quoted fields, backticks and original order total", () => {
  const rows = parseWechatTradeBill(csv);
  assertEquals(rows.length, 1); assertEquals(rows[0].total, 3900); assertEquals(rows[0].outTradeNo, "order1");
  assertThrows(() => parseWechatTradeBill(csv.replace("订单金额", "应结订单金额")));
  assertThrows(() => parseWechatTradeBill(csv.replace("总交易单数,订单总金额\n`1,`39.00\n", "")));
  assertThrows(() => parseWechatTradeBill(csv.replace('"Pro, 月付"', "Pro, 月付")));
});
Deno.test("daily comparison catches delivered mismatch, unknown orders and missing local payments", () => {
  const rows = parseWechatTradeBill(csv);
  assertEquals(compareWechatBill(rows, [payment], [], "2026-11-03", config).differences, []);
  assert(compareWechatBill(rows, [{ ...payment, orders: { ...payment.orders, amount_minor: 3800 } }], [], "2026-11-03", config).differences.some(item => item.type === "payment_details_mismatch"));
  assert(compareWechatBill(rows, [{ ...payment, payment_state: "NOTPAY", orders: { ...payment.orders, status: "pending" } }], [], "2026-11-03", config).differences.some(item => item.type === "payment_not_delivered"));
  assertEquals(compareWechatBill(rows, [], [], "2026-11-03", config).differences[0].type, "unknown_bill_order");
  assertEquals(compareWechatBill([], [payment], [], "2026-11-03", config).differences[0].type, "local_payment_missing_from_bill");
  assertEquals(compareWechatBill(rows, [payment], [], "2026-11-02", config).differences, []);
  assertEquals(compareWechatBill([], [{ ...payment, success_time: null }], [], "2026-11-03", config).differences[0].type, "payment_time_missing");
});
Deno.test("refund bills are acceptance evidence, never a final refund status or entitlement instruction", () => {
  const row: BillRow = { ...parseWechatTradeBill(csv)[0], state: "REFUND", outRefundNo: "refund1", refundId: "wx-refund1", refund: 3900 };
  const refund: LocalRefund = { order_id: payment.order_id, out_refund_no: "refund1", refund_id: "wx-refund1", amount_minor: 3900, state: "processing", create_time: "2026-11-03T08:00:00+08:00" };
  const oldPayment = { ...payment, success_time: "2026-11-01T08:00:00+08:00" };
  assertEquals(compareWechatBill([row], [oldPayment], [refund], "2026-11-03", config).differences, []);
  assertEquals(refund.state, "processing");
  assertEquals(compareWechatBill([row], [oldPayment], [], "2026-11-03", config).differences[0].type, "external_or_unknown_refund");
  assertEquals(compareWechatBill([row], [oldPayment], [{ ...refund, amount_minor: 3000 }], "2026-11-03", config).differences[0].type, "refund_details_mismatch");
  assertEquals(compareWechatBill([], [oldPayment], [refund], "2026-11-03", config).differences[0].type, "local_refund_missing_from_bill");
  assertEquals(compareWechatBill([], [oldPayment], [{ ...refund, create_time: null }], "2026-11-03", config).differences[0].type, "refund_time_missing");
});
Deno.test("bill download is restricted, signed, checksum verified and never follows redirects", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  const full = { ...config, privateKey: pem, merchantSerial: "ABCDEF" } as WechatPayConfig;
  const bytes = new TextEncoder().encode(csv);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  const manifest = { download_url: "https://api.mch.weixin.qq.com/v3/billdownload/file?token=test", hash_type: "SHA1", hash_value: hash };
  let calls = 0;
  const transport = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls++; assertEquals(String(url), manifest.download_url); assertEquals(init?.redirect, "error");
    assert(String((init?.headers as Record<string, string>).Authorization).startsWith("WECHATPAY2-SHA256-RSA2048 "));
    return Promise.resolve(new Response(bytes));
  }) as typeof fetch;
  assertEquals(await downloadWechatBill(full, manifest, transport), csv);
  for (const invalid of [
    { ...manifest, download_url: "https://other.invalid/v3/billdownload/file" },
    { ...manifest, download_url: "https://api.mch.weixin.qq.com/other" },
    { ...manifest, hash_type: "MD5" },
  ]) await assertRejects(() => downloadWechatBill(full, invalid, transport));
  assertEquals(calls, 1);
  await assertRejects(() => downloadWechatBill(full, { ...manifest, hash_value: "0".repeat(40) }, transport));
});

async function fixtureBillCredentials(): Promise<WechatPayConfig> {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const base64 = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return { ...config, merchantSerial: "SERIAL_TEST", publicKeyId: "PUB_KEY_ID_TEST",
    privateKey: `-----BEGIN PRIVATE KEY-----\n${base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey))}\n-----END PRIVATE KEY-----`,
  } as WechatPayConfig;
}

Deno.test("manifest diagnostics retain HTTP failure behavior and log only fixed classifications", async () => {
  const full = await fixtureBillCredentials();
  const admin = { from: () => { throw new Error("must not read or write the payment ledger"); } } as unknown as SupabaseClient;
  const originalFetch = globalThis.fetch, originalError = console.error;
  const events: unknown[] = [];
  console.error = (line: string) => { events.push(JSON.parse(line)); };
  try {
    for (const [upstream, expected] of [["NO_STATEMENT_EXIST", "NO_STATEMENT_EXIST"], ["STATEMENT_CREATING", "STATEMENT_CREATING"], ["PRIVATE_FIXTURE_ORDER", "unclassified"]]) {
      globalThis.fetch = () => Promise.resolve(Response.json({ code: upstream, message: "fixture-private-body" }, { status: 400 }));
      const error = await assertRejects(() => reconcileWechatBill(admin, full, "2020-11-03"), ApiError);
      assertEquals(error.status, 502);
      assertEquals(error.code, "upstream_failed");
      assertEquals(events.pop(), { event: "wechatpay_bill_failed", stage: "request_manifest", code: "upstream_failed", upstream_code: expected });
    }
    assertEquals(events, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

type AuditRow = { hash_value: string; status: string; report: Record<string, unknown> };
type LedgerFixture = { paymentRows?: unknown[]; refundRows?: unknown[]; missingTimeRows?: unknown[];
  pendingPayments?: number | null; pendingRefunds?: number | null; unavailableTable?: string;
  storedAudit?: AuditRow; signedAuditBeforeInsert?: AuditRow; failAuditRead?: boolean; becomesDated?: boolean };

function billLedger(fixture: LedgerFixture = {}) {
  const tableReads: string[] = [];
  const countPhases: string[] = [];
  const writes: Array<{ row: AuditRow; options: { onConflict?: string; ignoreDuplicates?: boolean } }> = [];
  let storedAudit = fixture.storedAudit;
  const admin = { from(table: string) {
    return {
      select(_fields: string, options?: { head?: boolean; count?: string }) {
        tableReads.push(table);
        const filters = new Map<string, unknown>();
        const scoped = () => {
          const prefix = table === "wechatpay_refunds" ? "wechatpay_payments." : "";
          assertEquals(filters.get(`${prefix}mchid`), config.mchid);
          assertEquals(filters.get(`${prefix}appid`), config.appid);
        };
        const chain = {
          eq(field: string, value: unknown) { filters.set(field, value); return chain; },
          is(field: string, value: unknown) { filters.set(field, value); return chain; },
          in(field: string, values: unknown[]) { filters.set(field, values); return chain; },
          not(field: string, operation: string, value: unknown) { filters.set(`not.${field}`, [operation, value]); return chain; },
          gte(field: string, value: unknown) { filters.set(`gte.${field}`, value); return chain; },
          lt(field: string, value: unknown) { filters.set(`lt.${field}`, value); return chain; },
          match(key: Record<string, unknown>) {
            assertEquals(key, { bill_date: "2026-11-19", ...config });
            return chain;
          },
          maybeSingle() { return Promise.resolve({ data: storedAudit, error: fixture.failAuditRead ? { code: "fixture" } : null }); },
          // `select(..., { head: true, count: "exact" })` is a PostgREST thenable for each ledger check.
          then(resolve: (result: unknown) => unknown) {
            scoped();
            assertEquals(options, { count: "exact", head: true });
            const isPayment = table === "wechatpay_payments";
            const timeField = isPayment ? "success_time" : "create_time";
            let count: number | null | undefined;
            if (filters.has("lt.created_at")) {
              countPhases.push("unresolved");
              assertEquals(filters.get("lt.created_at"), "2026-11-19T16:00:00.000Z");
              if (isPayment) assertEquals(filters.get("gte.time_expire"), "2026-11-18T16:00:00.000Z");
              count = isPayment ? fixture.pendingPayments : fixture.pendingRefunds;
            } else if (filters.get(timeField) === null) {
              countPhases.push("missing_time");
              if (isPayment) assertEquals(filters.get("payment_state"), "SUCCESS");
              else assertEquals(filters.get("not.refund_id"), ["is", null]);
              count = fixture.missingTimeRows?.length;
            } else {
              countPhases.push("dated");
              assertEquals(filters.get(`gte.${timeField}`), "2026-11-18T16:00:00.000Z");
              assertEquals(filters.get(`lt.${timeField}`), "2026-11-19T16:00:00.000Z");
              count = isPayment && fixture.becomesDated ? 1 : (isPayment ? fixture.paymentRows : fixture.refundRows)?.length;
            }
            if (fixture.unavailableTable === table) return Promise.resolve(resolve({ count: null, error: { code: "fixture" } }));
            return Promise.resolve(resolve({ count: count === undefined ? 0 : count, error: null }));
          },
        };
        return chain;
      },
      upsert(row: AuditRow, options: { onConflict?: string; ignoreDuplicates?: boolean }) {
        assertEquals(table, "wechatpay_bill_audits");
        writes.push({ row, options });
        if (fixture.signedAuditBeforeInsert) storedAudit = fixture.signedAuditBeforeInsert;
        if (!storedAudit || !options.ignoreDuplicates) storedAudit = row;
        return Promise.resolve({ error: null });
      },
    };
  } } as unknown as SupabaseClient;
  return { admin, tableReads, countPhases, writes, read: () => storedAudit };
}

Deno.test("provider no-file requires full app-scoped local verification and preserves signed audit evidence", async () => {
  const full = await fixtureBillCredentials();
  const now = new Date("2026-11-20T02:30:00Z"), day = "2026-11-19";
  const originalFetch = globalThis.fetch;
  let upstreamCode = "NO_STATEMENT_EXIST", responseStatus = 400, requests = 0;
  globalThis.fetch = (input, init) => {
    requests++;
    assertEquals(new URL(String(input)).pathname, "/v3/bill/tradebill");
    assertEquals(new URL(String(input)).searchParams.get("bill_type"), "ALL");
    assertEquals(init?.method, "GET");
    return Promise.resolve(Response.json({ code: upstreamCode }, { status: responseStatus }));
  };
  try {
    const empty = billLedger();
    const receipt = await reconcileWechatBill(empty.admin, full, day, now);
    assertEquals(receipt, { bill_date: day, status: "matched", payment_count: 0, refund_count: 0,
      difference_count: 0, source: "upstream_no_statement_local_empty" });
    assertEquals(requests, 1);
    assertEquals(empty.countPhases, ["unresolved", "unresolved", "missing_time", "missing_time", "dated", "dated"]);
    assertEquals(empty.writes[0].options, { onConflict: "bill_date,mchid,appid", ignoreDuplicates: true });
    assertEquals(empty.read()?.hash_value, "NO_STATEMENT_EXIST");
    assertEquals(empty.read()?.report.source, "upstream_no_statement_local_empty");
    assertEquals(empty.read()?.report.upstream_code, "NO_STATEMENT_EXIST");
    assertEquals(await reconcileWechatBill(empty.admin, full, day, now), receipt);

    const signed = { hash_value: "f".repeat(40), status: "matched", report: { payment_count: 0, refund_count: 0, differences: [] } };
    for (const fixture of [{ storedAudit: signed }, { signedAuditBeforeInsert: signed }]) {
      const prior = billLedger(fixture);
      const result = await reconcileWechatBill(prior.admin, full, day, now);
      assertEquals(result, { ...receipt, source: "signed_wechat_statement" });
      assertEquals(prior.read(), signed);
    }
    const signedDifferences = { ...signed, status: "differences", report: { payment_count: 1, refund_count: 0, differences: [{ type: "unknown_bill_order" }] } };
    const concurrent = billLedger({ signedAuditBeforeInsert: signedDifferences });
    const differences = await reconcileWechatBill(concurrent.admin, full, day, now);
    assertEquals(differences, { ...receipt, status: "differences", payment_count: 1, difference_count: 1, source: "signed_wechat_statement" });
    assertEquals(concurrent.read(), signedDifferences);
    const conflictingSigned = { ...signed, report: { ...signed.report, payment_count: 1 } };
    const conflict = billLedger({ storedAudit: conflictingSigned });
    assertEquals((await assertRejects(() => reconcileWechatBill(conflict.admin, full, day, now), ApiError)).status, 502);
    assertEquals(conflict.read(), conflictingSigned);
    const readbackUnavailable = billLedger({ failAuditRead: true });
    assertEquals((await assertRejects(() => reconcileWechatBill(readbackUnavailable.admin, full, day, now), ApiError)).status, 500);

    for (const fixture of [{ paymentRows: [payment] }, { refundRows: [{ out_refund_no: "test" }] },
      { missingTimeRows: [payment] }, { pendingPayments: 1 }, { pendingRefunds: 1 }, { pendingRefunds: null },
      { unavailableTable: "wechatpay_refunds" }]) {
      const uncertain = billLedger(fixture);
      await assertRejects(() => reconcileWechatBill(uncertain.admin, full, day, now), ApiError);
      assertEquals(uncertain.writes, []);
    }
    // An original record can acquire a target-day official timestamp after the first reads.
    const changing = billLedger({ becomesDated: true });
    assertEquals((await assertRejects(() => reconcileWechatBill(changing.admin, full, day, now), ApiError)).status, 502);
    assertEquals(changing.countPhases, ["unresolved", "unresolved", "missing_time", "missing_time", "dated", "dated"]);
    assertEquals(changing.writes, []);

    for (const [code, status, date, observedAt] of [
      ["STATEMENT_CREATING", 400, day, now], ["INVALID_REQUEST", 400, day, now], ["NO_STATEMENT_EXIST", 404, day, now],
      ["NO_STATEMENT_EXIST", 400, day, new Date("2026-11-20T01:59:59Z")], ["NO_STATEMENT_EXIST", 400, "2026-08-19", now],
    ] as const) {
      upstreamCode = code;
      responseStatus = status;
      const ineligible = billLedger();
      assertEquals((await assertRejects(() => reconcileWechatBill(ineligible.admin, full, date, observedAt), ApiError)).status, 502);
      assertEquals(ineligible.tableReads, []);
      assertEquals(ineligible.writes, []);
    }
  } finally { globalThis.fetch = originalFetch; }
});
