const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const VISION_TOOLS = new Set(["understand_image", "inspect_generated_image"]);

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function elapsed(start, finish) {
  if (!start || !finish) return null;
  const value = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function distribution(rows, key) {
  const result = {};
  for (const row of rows) {
    const value = row[key] || "unknown";
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function latency(values) {
  return {
    samples: values.length,
    averageMs: average(values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

/** 只接收 render_manifest 中的尺寸与 role；不保留 HTML、文案、hash 或对象路径。 */
export function summarizeRenderManifest(runId, value) {
  const document = value?.document;
  const outputs = Array.isArray(value?.outputs) ? value.outputs : [];
  const width = Number(document?.widthDevicePx);
  const height = Number(document?.heightDevicePx);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) return null;
  return {
    runId,
    devicePixels: width * height,
    slices: outputs.filter((output) => output?.role === "slice_screenshot").length,
    outputs: outputs.length,
  };
}

export function buildHtmlRenderObservation({ runs, tools, usage, artifacts, manifests, nowMs = Date.now() }) {
  const terminalRuns = runs.filter((run) => TERMINAL.has(run.status));
  const succeededRuns = runs.filter((run) => run.status === "succeeded");
  const failedRuns = runs.filter((run) => run.status === "failed");
  const completed = succeededRuns.length + failedRuns.length;
  const terminalDurations = terminalRuns.map((run) => elapsed(run.created_at, run.finished_at)).filter(Number.isFinite);
  const queueWaits = runs.map((run) => elapsed(run.queued_at, run.started_at)).filter(Number.isFinite);
  const renderDurations = tools
    .filter((tool) => tool.tool_name === "render_html" && tool.finished_at)
    .map((tool) => elapsed(tool.started_at, tool.finished_at)).filter(Number.isFinite);

  const toolsByRun = new Map();
  for (const tool of tools) {
    const bucket = toolsByRun.get(tool.run_id) ?? [];
    bucket.push(tool);
    toolsByRun.set(tool.run_id, bucket);
  }
  const renderCountViolations = [];
  for (const run of succeededRuns) {
    const count = (toolsByRun.get(run.id) ?? []).filter((tool) => tool.tool_name === "render_html").length;
    if (count !== 1) renderCountViolations.push({ runId: run.id, renderCalls: count });
  }
  const visionToolCalls = tools.filter((tool) => VISION_TOOLS.has(tool.tool_name)).length;
  const visionUsageItems = usage.filter((item) => item.kind === "vision_call");
  const htmlUsage = usage.filter((item) => item.kind === "html_render");
  const htmlCredits = htmlUsage.reduce((sum, item) => sum + Number(item.credits ?? 0), 0);
  const htmlOutputUnits = htmlUsage.map((item) => Number(item.output_units)).filter(Number.isFinite);

  const credits = terminalRuns.map((run) => Number(run.actual_credits)).filter(Number.isFinite);
  const artifactBytes = artifacts.map((artifact) => Number(artifact.bytes)).filter(Number.isFinite);
  const expiredArtifacts = artifacts.filter((artifact) => !artifact.deleted_at && Date.parse(artifact.expires_at) <= nowMs).length;
  const expiredRuns = runs.filter((run) => !run.content_deleted_at && Date.parse(run.content_expires_at) <= nowMs).length;
  const manifestPixels = manifests.map((manifest) => manifest.devicePixels).filter(Number.isFinite);
  const manifestSlices = manifests.map((manifest) => manifest.slices).filter(Number.isFinite);

  return {
    runs: {
      total: runs.length,
      statuses: distribution(runs, "status"),
      succeeded: succeededRuns.length,
      failed: failedRuns.length,
      cancelled: runs.filter((run) => run.status === "cancelled").length,
      active: runs.filter((run) => !TERMINAL.has(run.status)).length,
      successRate: completed ? succeededRuns.length / completed : null,
      failuresByCode: distribution(failedRuns, "error_code"),
      retriedRuns: runs.filter((run) => Number(run.attempt_count) > 1).length,
      duration: latency(terminalDurations),
      queueWait: latency(queueWaits),
      credits: {
        samples: credits.length,
        total: credits.reduce((sum, value) => sum + value, 0),
        average: average(credits),
        max: credits.length ? Math.max(...credits) : null,
      },
    },
    render: {
      toolCalls: tools.filter((tool) => tool.tool_name === "render_html").length,
      statuses: distribution(tools.filter((tool) => tool.tool_name === "render_html"), "status"),
      failuresByCode: distribution(tools.filter((tool) => tool.tool_name === "render_html" && tool.status !== "succeeded"), "safe_error_code"),
      duration: latency(renderDurations),
      exactlyOnceViolations: renderCountViolations,
      htmlUsageItems: htmlUsage.length,
      htmlCredits,
      averageOutputUnits: average(htmlOutputUnits),
    },
    vision: {
      toolCalls: visionToolCalls,
      usageItems: visionUsageItems.length,
      credits: visionUsageItems.reduce((sum, item) => sum + Number(item.credits ?? 0), 0),
    },
    artifacts: {
      total: artifacts.length,
      byRole: distribution(artifacts, "role"),
      totalBytes: artifactBytes.reduce((sum, value) => sum + value, 0),
      averageBytesPerRun: runs.length ? artifactBytes.reduce((sum, value) => sum + value, 0) / runs.length : null,
      expiredUndeletedInWindow: expiredArtifacts,
    },
    manifests: {
      sampled: manifests.length,
      averageDevicePixels: average(manifestPixels),
      p95DevicePixels: percentile(manifestPixels, 0.95),
      averageSlices: average(manifestSlices),
      p95Slices: percentile(manifestSlices, 0.95),
    },
    ttl: { expiredRunsInWindow: expiredRuns, expiredArtifactsInWindow: expiredArtifacts },
    invariants: {
      renderExactlyOnce: succeededRuns.length ? renderCountViolations.length === 0 : null,
      visionZero: runs.length ? visionToolCalls === 0 && visionUsageItems.length === 0 : null,
      rendererCreditsZero: htmlUsage.length ? htmlCredits === 0 : null,
    },
  };
}
