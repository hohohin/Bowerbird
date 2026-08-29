import test from "node:test";
import assert from "node:assert/strict";
import { buildHtmlRenderObservation, percentile, summarizeRenderManifest } from "./html-render-observation-lib.mjs";

test("percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
});

test("summarizes only manifest dimensions and output counts", () => {
  assert.deepEqual(summarizeRenderManifest("r1", {
    sourceHtmlSha256: "secret-ish-hash",
    document: { widthDevicePx: 720, heightDevicePx: 2000 },
    outputs: [{ role: "full_page_screenshot" }, { role: "slice_screenshot" }, { role: "slice_screenshot" }],
  }), { runId: "r1", devicePixels: 1_440_000, slices: 2, outputs: 3 });
  assert.equal(summarizeRenderManifest("r1", { document: { widthDevicePx: 0, heightDevicePx: 5 } }), null);
});

test("aggregates HTML test runs and enforces H6 invariants", () => {
  const runs = [
    { id: "r1", status: "succeeded", attempt_count: 1, actual_credits: 2, created_at: "2026-01-01T00:00:00Z", queued_at: "2026-01-01T00:00:01Z", started_at: "2026-01-01T00:00:03Z", finished_at: "2026-01-01T00:00:10Z", content_expires_at: "2027-01-01T00:00:00Z", content_deleted_at: null },
    { id: "r2", status: "failed", error_code: "render_timeout", attempt_count: 2, actual_credits: 1, created_at: "2026-01-01T00:00:00Z", queued_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:01Z", finished_at: "2026-01-01T00:00:05Z", content_expires_at: "2025-01-01T00:00:00Z", content_deleted_at: null },
  ];
  const tools = [
    { run_id: "r1", tool_name: "render_html", status: "succeeded", started_at: "2026-01-01T00:00:04Z", finished_at: "2026-01-01T00:00:08Z" },
    { run_id: "r2", tool_name: "render_html", status: "failed", safe_error_code: "render_timeout", started_at: "2026-01-01T00:00:02Z", finished_at: "2026-01-01T00:00:04Z" },
  ];
  const usage = [
    { run_id: "r1", kind: "html_render", credits: 0, output_units: 4 },
    { run_id: "r1", kind: "model_tokens", credits: 2, output_units: 50 },
  ];
  const artifacts = [
    { run_id: "r1", role: "full_page_screenshot", bytes: 100, expires_at: "2027-01-01T00:00:00Z", deleted_at: null },
    { run_id: "r2", role: "diagnostic", bytes: 10, expires_at: "2025-01-01T00:00:00Z", deleted_at: null },
  ];
  const report = buildHtmlRenderObservation({
    runs, tools, usage, artifacts,
    manifests: [{ runId: "r1", devicePixels: 1_440_000, slices: 3, outputs: 4 }],
    nowMs: Date.parse("2026-01-02T00:00:00Z"),
  });
  assert.equal(report.runs.successRate, 0.5);
  assert.equal(report.runs.retriedRuns, 1);
  assert.equal(report.runs.duration.p50Ms, 5_000);
  assert.deepEqual(report.runs.failuresByCode, { render_timeout: 1 });
  assert.equal(report.render.duration.p95Ms, 4_000);
  assert.equal(report.manifests.averageSlices, 3);
  assert.deepEqual(report.invariants, { renderExactlyOnce: true, visionZero: true, rendererCreditsZero: true });
  assert.equal(report.ttl.expiredRunsInWindow, 1);
  assert.equal(report.ttl.expiredArtifactsInWindow, 1);
});

test("does not report sample-dependent gates as passing with zero runs", () => {
  const report = buildHtmlRenderObservation({ runs: [], tools: [], usage: [], artifacts: [], manifests: [] });
  assert.deepEqual(report.invariants, { renderExactlyOnce: null, visionZero: null, rendererCreditsZero: null });
});
