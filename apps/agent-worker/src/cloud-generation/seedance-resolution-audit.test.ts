import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { createSeedanceResolutionAudit, SEEDANCE_AUDIT_INTERVAL, SEEDANCE_SPEC_URL, seedanceDocumentResolutions } from "./seedance-resolution-audit.ts";

const document = (values = "480p 720p 1080p") => `<script>通过 resolution 参数指定输出视频的分辨率。可选值：4k 说明</script>
  <h3>分辨率</h3><p>通过 <code>resolution</code> 参数指定输出视频的分辨率。</p><p>默认值：720p 可选值：</p><ul><li>${values}</li></ul><p>说明</p><p>其他模型 4k</p>`;
function response(html: string, onCancel = () => {}): Response {
  let read = false;
  return { ok: true, status: 200, text: async () => html, json: async () => ({}), body: { getReader: () => ({
    read: async () => { const done = read; read = true; return { done, value: done ? new Uint8Array() : new TextEncoder().encode(html) }; },
    cancel: async () => { onCancel(); }, releaseLock: () => {},
  }) } };
}
test("resolution audit isolates the official enum and reports changes without mutating the contract", async () => {
  deepEqual(seedanceDocumentResolutions(document()), ["1080p", "480p", "720p"]);
  const logs: Record<string, unknown>[] = [];
  const check = createSeedanceResolutionAudit({ fetch: async (url, init) => {
    equal(url, SEEDANCE_SPEC_URL); equal(init.method, "GET"); equal(init.redirect, "error");
    deepEqual(Object.keys(init).sort(), ["method", "redirect", "signal"]);
    return response(document("480p 720p 1080p 4k"));
  }, log: record => logs.push(record) });
  await check(); equal(logs[0].status, "changed");
  deepEqual(logs[0].expected, ["1080p", "480p", "720p"]); deepEqual(logs[0].observed, ["1080p", "480p", "4k", "720p"]);
});
test("audit runs once per day, coalesces concurrent checks and recognizes unchanged specs", async () => {
  let time = 0, calls = 0;
  const logs: Record<string, unknown>[] = [];
  const check = createSeedanceResolutionAudit({ now: () => time, fetch: async () => { calls++; return response(document()); }, log: record => logs.push(record) });
  await Promise.all([check(), check(), check()]); equal(calls, 1); equal(logs[0].status, "unchanged");
  time = SEEDANCE_AUDIT_INTERVAL - 1; await check(); equal(calls, 1);
  time++; await check(); equal(calls, 2);
});
test("network, page layout and size failures are isolated and retain the known options", async () => {
  let cancelled = 0;
  for (const fetcher of [async () => { throw new Error("private transport detail"); }, async () => response("login or changed markup"),
    async () => response("x".repeat(4 * 1024 * 1024 + 1), () => cancelled++)]) {
    const logs: Record<string, unknown>[] = [];
    const check = createSeedanceResolutionAudit({ fetch: fetcher, log: record => logs.push(record) });
    await check(); await check(); equal(logs.length, 1); equal(logs[0].status, "unavailable");
    deepEqual(logs[0].expected, ["1080p", "480p", "720p"]);
    equal(JSON.stringify(logs).includes("private transport detail"), false);
  }
  equal(cancelled, 1);
});
