// Real production HTML layout Agent E2E. Uses a disposable test account and
// synthetic text + one generated pixel reference; no private assets or Vision calls are involved.
// Usage: node scripts/test-html-layout-agent-e2e.mjs

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (match) out[match[1]] = match[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

const env = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const baseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = env.SUPABASE_SECRET_KEY;
if (!baseUrl || !publishableKey || !secretKey) {
  console.error("缺少 apps/cloud/.env 中的 SUPABASE_URL / publishable / secret key");
  process.exit(2);
}

const adminHeaders = {
  apikey: secretKey,
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const functionUrl = (name) => `${baseUrl}/functions/v1/${name}`;
const restUrl = (table, query) => `${baseUrl}/rest/v1/${table}?${query}`;
const storageUrl = (key) => `${baseUrl}/storage/v1/object/agent-temp/${key.split("/").map(encodeURIComponent).join("/")}`;

async function jsonRequest(label, url, init, expected = [200, 202]) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!expected.includes(response.status)) {
    const code = body?.error?.code ?? body?.code ?? "unknown";
    const message = body?.error?.message ?? body?.message ?? "无错误详情";
    throw new Error(`${label}失败（HTTP ${response.status}, ${code}）：${message}`);
  }
  return body;
}

async function createAccount() {
  const email = `html-layout-e2e-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const created = await jsonRequest("创建临时账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  }, [200, 201]);
  const session = await jsonRequest("临时账号登录", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    userId: created.id,
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
    },
  };
}

async function getRun(headers, runId) {
  return await jsonRequest("查询 HTML Run", functionUrl("agent-run"), {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "get", runId }),
  });
}

async function waitFor(headers, runId, wanted, maxWaitMs = 12 * 60_000) {
  const started = Date.now();
  for (;;) {
    const snapshot = await getRun(headers, runId);
    const status = snapshot.run?.status;
    process.stdout.write(`\rstatus=${status ?? "unknown"} step=${snapshot.run?.current_step ?? "-"} progress=${snapshot.run?.progress ?? 0}%   `);
    if (status === wanted) {
      process.stdout.write("\n");
      return snapshot;
    }
    if (["failed", "cancelled"].includes(status)) {
      process.stdout.write("\n");
      throw new Error(`Run 提前结束：${status} / ${snapshot.run?.error_code ?? "unknown"} / ${snapshot.run?.safe_message ?? ""}`);
    }
    if (Date.now() - started > maxWaitMs) throw new Error(`等待 ${wanted} 超过 ${maxWaitMs / 1000} 秒`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function tableRows(table, runId, select) {
  return await jsonRequest(`读取 ${table}`, restUrl(
    table,
    `run_id=eq.${encodeURIComponent(runId)}&select=${encodeURIComponent(select)}`,
  ), { method: "GET", headers: adminHeaders });
}

async function downloadArtifact(artifact) {
  const response = await fetch(storageUrl(artifact.object_key), {
    headers: adminHeaders,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.ok, true, `${artifact.role} 下载失败：${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.byteLength, Number(artifact.bytes), `${artifact.role} bytes 不一致`);
  assert.equal(sha256(bytes), artifact.sha256, `${artifact.role} SHA-256 不一致`);
  return bytes;
}

let account;
let runId;
let cleanupKeys = [];
try {
  account = await createAccount();
  const layoutPrompt = [
    "把以下合成测试文案排成一张中文纵向信息海报。",
    "主标题：离线排版验收；副标题：单次生成、单次渲染、零网络依赖。",
    "正文分三段：安全边界、确定性产物、资源上限。每段各写一行给定说明，不新增事实。",
    "页尾：Bowerbird HTML Renderer H0。使用米白背景、深灰文字和蓝色强调色。",
    "把 @图1 作为一个小型参考色块放在页尾旁边。",
  ].join("\n");
  const referenceBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const referenceArtifactId = randomUUID();
  const requestObject = {
    schemaVersion: 1,
    layoutPrompt,
    references: [{
      artifactId: referenceArtifactId,
      token: "@图1",
      ordinal: 1,
      mime: "image/png",
      bytes: referenceBytes.byteLength,
      sha256: sha256(referenceBytes),
    }],
    viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 500, overlapCssPx: 0 },
    background: "opaque",
  };
  const manifest = JSON.stringify(requestObject);
  const created = await jsonRequest("创建 HTML Run", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-html-layout-render",
      goal: layoutPrompt,
      inputCount: 1,
      inputManifestHash: sha256(manifest),
      idempotencyKey: `html-layout-e2e-${randomBytes(8).toString("hex")}`,
    }),
  });
  runId = created.runId;
  assert.equal(created.budgetCredits, 15, "HTML Run 预算应为 15 积分");
  const upload = await fetch(created.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-upsert": "true" },
    body: manifest,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(upload.ok, true, `request.json 上传失败：${upload.status}`);
  assert.equal(created.inputUploads.length, 1, "HTML 参考图应获得一个签名上传地址");
  const referenceUpload = await fetch(created.inputUploads[0].uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/png", "x-upsert": "true" },
    body: referenceBytes,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(referenceUpload.ok, true, `HTML 参考图上传失败：${referenceUpload.status}`);
  await jsonRequest("HTML Run 入队", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "enqueue", runId }),
  });

  const review = await waitFor(account.headers, runId, "awaiting_result_feedback");
  assert.equal(review.run.skill_id, "bowerbird-html-layout-render");
  assert.equal(review.run.skill_version, "0.1.0", "HTML Skill 版本映射错误");
  assert.equal(review.renderManifest.outputs.length >= 2, true, "用户快照应携带可验证的 render manifest");
  await jsonRequest("拒绝 HTML 修订反馈", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "retry", text: "再做一次" }),
  }, [409]);

  const artifacts = await tableRows(
    "agent_artifacts",
    runId,
    "id,kind,role,object_key,mime,bytes,sha256,user_visible,source_call_id",
  );
  cleanupKeys = artifacts.map((artifact) => artifact.object_key);
  const byRole = (role) => artifacts.filter((artifact) => artifact.role === role);
  assert.equal(byRole("html_document").length, 1, "应登记一份私有 HTML 文档");
  assert.equal(byRole("render_manifest").length, 1, "应登记一份私有 render manifest");
  assert.equal(byRole("input").length, 1, "应登记一张显式 HTML 参考图");
  assert.equal(byRole("input")[0].id, referenceArtifactId, "HTML manifest 与 claim 的 artifact id 应一致");
  assert.equal(byRole("full_page_screenshot").length, 1, "应登记一张整页截图");
  assert.ok(byRole("slice_screenshot").length >= 1, "应至少登记一张切片截图");
  assert.equal(byRole("html_document")[0].user_visible, false);
  assert.equal(byRole("render_manifest")[0].user_visible, false);
  assert.ok(byRole("full_page_screenshot")[0].user_visible);

  const fullPageBytes = await downloadArtifact(byRole("full_page_screenshot")[0]);
  assert.deepEqual([...fullPageBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "整页产物不是实际 PNG");
  const renderManifest = JSON.parse((await downloadArtifact(byRole("render_manifest")[0])).toString("utf8"));
  assert.match(renderManifest.rendererFingerprint, /^bwr1-[0-9a-f]{32}$/);
  assert.equal(renderManifest.outputs.length, byRole("full_page_screenshot").length + byRole("slice_screenshot").length);
  const signed = await jsonRequest("签发 HTML 截图下载地址", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "artifact_url", artifactId: byRole("full_page_screenshot")[0].id }),
  });
  const signedResponse = await fetch(signed.url, { signal: AbortSignal.timeout(60_000) });
  assert.equal(signedResponse.ok, true, "桌面可见 HTML 截图签名地址不可下载");

  const toolCalls = await tableRows(
    "agent_tool_calls",
    runId,
    "call_id,phase,tool_name,status,result_hash",
  );
  assert.equal(toolCalls.filter((call) => call.tool_name === "compose_html_document" && call.status === "succeeded").length, 1);
  assert.equal(toolCalls.filter((call) => call.tool_name === "render_html" && call.status === "succeeded").length, 1);

  const usageBeforeFinish = await tableRows(
    "agent_usage_items",
    runId,
    "call_id,kind,provider,model,input_units,output_units,credits",
  );
  assert.equal(usageBeforeFinish.filter((item) => item.kind === "html_render" && item.provider === "renderer").length, 1);
  assert.equal(usageBeforeFinish.filter((item) => item.kind === "html_render")[0].credits, 0);
  assert.ok(usageBeforeFinish.some((item) => item.kind === "model_tokens" && item.provider === "deepseek"));
  assert.equal(usageBeforeFinish.filter((item) => item.kind === "vision_call" || item.kind === "image_generation").length, 0);

  await jsonRequest("接受 HTML 结果", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "accept" }),
  });
  await jsonRequest("重复接受应幂等拒绝", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "accept" }),
  }, [409]);
  const finished = await waitFor(account.headers, runId, "succeeded");
  const usage = await tableRows("agent_usage_items", runId, "call_id,kind,provider,credits");
  const usageCredits = usage.reduce((sum, item) => sum + Number(item.credits), 0);
  assert.equal(finished.run.actual_credits, usageCredits, "Run 终态积分未与 usage ledger 对账");

  console.log("HTML_LAYOUT_AGENT_E2E_OK");
  console.log(`run=${runId} skill=${finished.run.skill_version} fingerprint=${renderManifest.rendererFingerprint} outputs=${renderManifest.outputs.length} credits=${finished.run.actual_credits}`);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
} finally {
  if (runId && account?.headers) {
    try {
      const snapshot = await getRun(account.headers, runId);
      if (!["succeeded", "failed", "cancelled"].includes(snapshot.run?.status)) {
        await jsonRequest("取消未完成 HTML Run", functionUrl("agent-run"), {
          method: "POST",
          headers: account.headers,
          body: JSON.stringify({ action: "cancel", runId }),
        });
      }
      const runs = await jsonRequest("读取 Run 临时对象", restUrl(
        "agent_runs",
        `id=eq.${encodeURIComponent(runId)}&select=request_object_key,checkpoint_object_key,feedback_object_key`,
      ), { method: "GET", headers: adminHeaders });
      cleanupKeys.push(...Object.values(runs[0] ?? {}).filter(Boolean));
    } catch { /* cleanup is best-effort */ }
  }
  for (const key of new Set(cleanupKeys)) {
    try {
      await fetch(storageUrl(key), { method: "DELETE", headers: adminHeaders, signal: AbortSignal.timeout(30_000) });
    } catch { /* cleanup is best-effort */ }
  }
  if (account?.userId) {
    try {
      await fetch(`${baseUrl}/auth/v1/admin/users/${account.userId}`, {
        method: "DELETE",
        headers: adminHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch { /* cleanup is best-effort */ }
  }
}
