// H5-T5 完整生产 E2E 审计：真实 Supabase 控制面 + 生产 VPS Worker + html-renderer 容器。
//
// 链路：测试账号（bowerbird_test 标记，满足 HTML Skill test-only 门控）
//   → agent-run create（0 参考图合成中文长页排版目标 + 闭集 manifest）
//   → 上传 request.json → enqueue → 生产 Worker 消费（DeepSeek compose + renderer 渲染）
//   → awaiting_result_feedback → accept → succeeded
//   → 审计断言（service role 直查控制面）：
//       tool ledger：compose_html_document ×1 + render_html ×1，全部 succeeded
//       artifacts：html_document/render_manifest/full_page/slice_screenshot 闭集 + 切片 parent=整页
//       usage：html_render 0 积分、model_tokens ≥1、**vision_call 必须为 0（Vision=0 验收）**
//       结算：0 < actual_credits ≤ 15 且等于文本回合计费；content_expires_at 非空（TTL 可审计）
//   → 下载整页+切片 → clip 连续 + 逐像素拼接复原
//
// 运行：cd apps/cloud && node --env-file=.env scripts/test-html-render-e2e.mjs
// 输出仅无内容审计摘要；任一断言失败退出码 1。

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
if (!baseUrl || !secretKey || !publishableKey) {
  console.error("缺少 SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY");
  process.exit(2);
}
const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const runUrl = `${baseUrl}/functions/v1/agent-run`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function request(label, url, init, expected = [200]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 保留 text */ }
  if (!expected.includes(response.status)) {
    throw new Error(`${label}: HTTP ${response.status} / ${body?.error?.code ?? ""} / ${body?.error?.message ?? text?.slice(0, 200)}`);
  }
  return body;
}

async function waitForStatus(label, userHeaders, runId, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const body = await request("get", runUrl, {
      method: "POST", headers: userHeaders,
      body: JSON.stringify({ action: "get", runId }),
    });
    last = body?.run?.status ?? "unknown";
    if (statuses.includes(last)) return body;
    if (["failed", "cancelled"].includes(last)) {
      throw new Error(`${label}: 终态 ${last} / ${body?.run?.error_code ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error(`${label}: 超时（last=${last}）`);
}

async function rest(label, path, select, filter) {
  const query = new URLSearchParams({ select });
  for (const [column, value] of Object.entries(filter ?? {})) query.set(column, `eq.${value}`);
  return await request(label, `${baseUrl}/rest/v1/${path}?${query}`, { headers: adminHeaders });
}

const LAYOUT_PROMPT = "制作一张中文长页排版：标题「离线排版验收」，正文分 32 段，每段一行文字「第 N 段 · 合成验收样例」，每段高 120 像素，底色按段渐变，文字白色居左。";
const manifest = {
  schemaVersion: 1,
  layoutPrompt: LAYOUT_PROMPT,
  references: [],
  viewport: { widthCssPx: 720, heightCssPx: 960, deviceScaleFactor: 1 },
  capture: { mode: "full_page_and_slices", sliceHeightCssPx: 960, overlapCssPx: 0 },
  background: "opaque",
};

let userId;
let userHeaders;
let runId;
const startedAt = Date.now();
try {
  // 1) 测试账号（bowerbird_test 标记 → entitlement 追加 HTML Skill）
  const email = `html-render-e2e-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const created = await request("创建测试账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  }, [200, 201]);
  userId = created.id;
  const session = await request("登录", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  userHeaders = {
    apikey: publishableKey,
    authorization: `Bearer ${session.access_token}`,
    "content-type": "application/json",
  };

  // 2) create → 上传 manifest → enqueue
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const createdRun = await request("create", runUrl, {
    method: "POST", headers: userHeaders,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-html-layout-render",
      goal: LAYOUT_PROMPT,
      inputCount: 0,
      inputManifestHash: sha256(manifestBytes),
      idempotencyKey: `html-e2e-${Date.now()}-${randomBytes(4).toString("hex")}`,
      imageProvider: "cloud",
    }),
  });
  runId = createdRun.runId;
  const upload = await fetch(createdRun.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-upsert": "true" },
    body: manifestBytes,
    signal: AbortSignal.timeout(60_000),
  });
  if (!upload.ok) throw new Error(`manifest 上传失败: HTTP ${upload.status}`);
  await request("enqueue", runUrl, {
    method: "POST", headers: userHeaders,
    body: JSON.stringify({ action: "enqueue", runId }),
  });

  // 3) 生产 Worker 消费：compose（DeepSeek）+ render（renderer 容器）→ awaiting_result_feedback
  const parked = await waitForStatus("渲染完成", userHeaders, runId, ["awaiting_result_feedback"], 6 * 60_000);
  const renderWaitMs = Date.now() - startedAt;

  // 4) accept → succeeded（exporting → settled）
  await request("result_feedback", runUrl, {
    method: "POST", headers: userHeaders,
    body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "accept", text: "验收通过" }),
  });
  await waitForStatus("结算完成", userHeaders, runId, ["succeeded"], 3 * 60_000);
  const totalMs = Date.now() - startedAt;

  // ———— 审计断言（service role） ————
  const [runRow] = await rest("run", "agent_runs", "id,status,actual_credits,budget_credits,content_expires_at,error_code", { id: runId });
  assert.equal(runRow.status, "succeeded");
  assert.ok(runRow.actual_credits > 0 && runRow.actual_credits <= runRow.budget_credits, `积分异常:${runRow.actual_credits}/${runRow.budget_credits}`);
  assert.ok(runRow.content_expires_at, "content_expires_at 为空（TTL 不可审计）");

  const toolCalls = await rest("tools", "agent_tool_calls", "*", { run_id: runId });
  const names = toolCalls.map((c) => `${c.tool_name}:${c.status}`).sort();
  const count = (prefix) => names.filter((n) => n.startsWith(prefix)).length;
  assert.equal(count("compose_html_document:succeeded"), 1, `tool ledger: ${names}`);
  assert.equal(count("render_html:succeeded"), 1, `每 Run 恰好一次 render: ${names}`);
  assert.ok(count("model_turn:succeeded") >= 1, `文本回合已入账: ${names}`);
  assert.ok(!names.some((n) => n.startsWith("understand_image") || n.startsWith("inspect_generated_image")), `Vision 工具必须为 0: ${names}`);

  const artifacts = await rest("artifacts", "agent_artifacts", "*", { run_id: runId });
  const byRole = {};
  for (const artifact of artifacts) (byRole[artifact.role] ??= []).push(artifact);
  assert.equal(byRole.html_document?.length, 1, "html_document ×1");
  assert.equal(byRole.render_manifest?.length, 1, "render_manifest ×1");
  assert.equal(byRole.full_page_screenshot?.length, 1, "full_page ×1");
  assert.ok((byRole.slice_screenshot?.length ?? 0) >= 3, `切片 ≥3（实际 ${byRole.slice_screenshot?.length ?? 0}）`);
  const full = byRole.full_page_screenshot[0];
  for (const slice of byRole.slice_screenshot) {
    assert.equal(slice.parent_artifact_id, full.id, "切片 parent 必须是整页");
    assert.equal(slice.user_visible, true);
  }
  assert.equal(byRole.render_manifest[0].user_visible, false, "manifest 不对用户可见");
  const allowedRoles = new Set(["html_document", "render_manifest", "viewport_screenshot", "full_page_screenshot", "slice_screenshot", "diagnostic"]); // diagnostic = DeepSeek 文本回合脱敏结果（既有机制）
  assert.ok(artifacts.every((a) => allowedRoles.has(a.role)), `artifact role 闭集: ${artifacts.map((a) => a.role).join(",")}`);

  const usage = await rest("usage", "agent_usage_items", "*", { run_id: runId });
  const usageByKind = {};
  for (const item of usage) usageByKind[item.kind] = (usageByKind[item.kind] ?? 0) + item.credits;
  assert.equal(usageByKind.vision_call ?? 0, 0, `Vision usage 必须为 0（实际 ${JSON.stringify(usageByKind)}）`);
  assert.ok((usageByKind.html_render ?? -1) === 0, "html_render 必须 0 积分");
  assert.ok((usage.filter((i) => i.kind === "model_tokens").length) >= 1, "DeepSeek 文本回合已计量");
  assert.equal(runRow.actual_credits, usageByKind.model_tokens ?? 0, "结算 = 文本回合积分");

  const events = await rest("events", "agent_events", "*", { run_id: runId });
  const eventTypes = new Set(events.map((e) => e.type));
  assert.ok(eventTypes.has("html.render.completed"), "缺 html.render.completed 事件");
  assert.ok(eventTypes.has("result.ready"), "缺 result.ready 事件");

  // ———— 像素连续性：下载整页 + 切片 → clip 连续 + 拼接复原 ————
  // 审计通道：service role 直接对 storage 签名下载（render_manifest 不对用户可见，
  // artifact_url 的 403 正是其访问边界的正确行为）。
  const artifactByKey = new Map(artifacts.map((a) => [a.sha256, a]));
  async function downloadObject(objectKey) {
    const signed = await request("sign", `${baseUrl}/storage/v1/object/sign/agent-temp/${objectKey}`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ expiresIn: 60 }),
    });
    const response = await fetch(`${baseUrl}/storage/v1${signed.signedURL}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`对象下载失败 ${objectKey.slice(-24)}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const { decodePng } = await import("../../html-renderer/src/png.ts");
  const manifestArtifact = byRole.render_manifest[0];
  const manifestJson = JSON.parse(new TextDecoder().decode(await downloadObject(manifestArtifact.object_key)));
  const slicesInfo = manifestJson.outputs.filter((o) => o.role === "slice_screenshot").sort((a, b) => a.index - b.index);
  const fullBytes = await downloadObject(full.object_key);
  const fullDecoded = decodePng(fullBytes);
  if ("reason" in fullDecoded) throw new Error(`整页 PNG 无效:${fullDecoded.reason}`);
  assert.equal(fullDecoded.width, 720, `整页宽 ${fullDecoded.width}`);

  let cursor = 0;
  const rebuilt = new Uint8Array(fullDecoded.rgba.length);
  for (const info of slicesInfo) {
    const artifact = byRole.slice_screenshot.find((a) => a.sha256 === info.sha256);
    if (!artifact) throw new Error(`切片 ${info.index} 不在 artifact 表`);
    const decoded = decodePng(await downloadObject(artifact.object_key));
    if ("reason" in decoded) throw new Error(`切片 PNG 无效:${decoded.reason}`);
    if (decoded.width !== fullDecoded.width) throw new Error("切片宽度不一致");
    assert.equal(info.clipDevicePx.y, cursor, `切片 ${info.index} clip 不连续`);
    rebuilt.set(decoded.rgba, info.clipDevicePx.y * fullDecoded.width * 4);
    cursor += info.clipDevicePx.height;
  }
  assert.equal(cursor, fullDecoded.height, "切片高度和 ≠ 整页高");
  let mismatch = 0;
  for (let i = 0; i < fullDecoded.rgba.length; i += 1) if (rebuilt[i] !== fullDecoded.rgba[i]) mismatch += 1;
  assert.equal(mismatch, 0, `拼接像素不一致:${mismatch}`);

  console.log(JSON.stringify({
    event: "html_render_e2e_ok",
    runId: runId.slice(0, 8),
    visionUsage: 0,
    toolCalls: names,
    artifacts: { total: artifacts.length, slices: byRole.slice_screenshot.length },
    usage: usageByKind,
    actualCredits: runRow.actual_credits,
    document: `${fullDecoded.width}x${fullDecoded.height}`,
    renderWaitMs: Math.round(renderWaitMs),
    totalMs: Math.round(totalMs),
    contentExpiresAt: runRow.content_expires_at,
  }));
} catch (error) {
  console.error(JSON.stringify({ event: "html_render_e2e_failed", runId: runId?.slice(0, 8), error: String(error.message ?? error).slice(0, 300) }));
  process.exitCode = 1;
} finally {
  if (userId) {
    await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: adminHeaders })
      .catch(() => undefined);
  }
}
