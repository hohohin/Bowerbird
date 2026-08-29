/**
 * 无内容指标单测 —— H5-T4。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderMetrics } from "./metrics.ts";

test("aggregates counters, failure codes and percentiles without content", () => {
  const metrics = new RenderMetrics(30_000);
  assert.deepEqual(metrics.snapshot().renders, 0);
  assert.equal(metrics.snapshot().p50RenderMs, null);

  for (let i = 1; i <= 100; i += 1) metrics.record({ ok: true }, i);
  metrics.record({ ok: false, code: "render_document_too_large" }, 5_000);
  metrics.record({ ok: false, code: "render_capacity_busy" }, 40_000);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.renders, 102);
  assert.equal(snapshot.okRenders, 100);
  assert.equal(snapshot.failedRenders, 2);
  assert.deepEqual(snapshot.failuresByCode, { render_document_too_large: 1, render_capacity_busy: 1 });
  assert.equal(snapshot.overBudgetRenders, 1, "仅超时限的渲染计入 overBudget");
  assert.equal(snapshot.maxRenderMs, 40000);
  // 窗口含全部 102 个样本：p50 落在 51/52 附近，p95 在 97 附近（含 5000/40000 拉高）
  assert.ok(snapshot.p50RenderMs! >= 50 && snapshot.p50RenderMs! <= 52, `p50=${snapshot.p50RenderMs}`);
  assert.ok(snapshot.p95RenderMs! >= 97, `p95=${snapshot.p95RenderMs}`);
});

test("latency window keeps only recent samples", () => {
  const metrics = new RenderMetrics(1_000_000);
  for (let i = 0; i < 300; i += 1) metrics.record({ ok: true }, 5);
  // 若无窗口淘汰，310 个样本的 p95 会落在尾部的高值上；有窗口（256）则 p95 仍是 5ms。
  for (let i = 0; i < 10; i += 1) metrics.record({ ok: true }, 9_000);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.renders, 310);
  assert.equal(snapshot.maxRenderMs, 9_000);
  assert.equal(snapshot.p95RenderMs, 5, "窗口外旧样本被淘汰（若全量保留 p95 将为 9000）");
});
