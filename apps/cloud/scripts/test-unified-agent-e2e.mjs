// Real production unified DSH Agent E2E for an exact-copy detail page.
// The script approves only the strict compose -> render -> inspect -> finalize plan,
// downloads auditable artifacts, verifies copy fidelity, and then accepts the result.
//
// Usage:
//   BOWERBIRD_U6_ALLOW_REAL_PROVIDER_COSTS=1 node scripts/test-unified-agent-e2e.mjs \
//     --allow-real-provider-costs --request=<request.json> --input=<reference.jpg>

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map(process.argv.slice(2).map((arg) => {
  const separator = arg.indexOf("=");
  return separator < 0 ? [arg, true] : [arg.slice(0, separator), arg.slice(separator + 1)];
}));
const allowRealCosts = args.get("--allow-real-provider-costs") === true &&
  process.env.BOWERBIRD_U6_ALLOW_REAL_PROVIDER_COSTS === "1";
const requestArgument = args.get("--request");
const inputArgument = args.get("--input");
if (!allowRealCosts || typeof requestArgument !== "string" || typeof inputArgument !== "string") {
  console.error("本脚本会调用真实 DeepSeek、火山方舟 Vision 与 renderer。必须同时提供双费用门禁、--request 和 --input。");
  process.exit(2);
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (match) out[match[1]] = match[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const cloudDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(cloudDirectory, "..", "..");
const resolveArgument = (value) => path.resolve(repositoryDirectory, value);
const requestPath = resolveArgument(requestArgument);
const inputPath = resolveArgument(inputArgument);

const env = parseEnv(await readFile(path.join(cloudDirectory, ".env"), "utf8"));
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

function actualMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("参考图不是受支持的 PNG/JPEG/WebP");
}

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
  const email = `unified-agent-e2e-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
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
  return await jsonRequest("查询统一 Agent Run", functionUrl("agent-run"), {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "get", runId }),
  });
}

async function waitFor(headers, runId, wanted, maxWaitMs = 20 * 60_000) {
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

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normalizedText(value) {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function htmlPlainText(html) {
  const withoutStyle = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return normalizedText(decodeHtmlEntities(withoutStyle.replace(/<[^>]+>/g, " ")));
}

function exactCopyLines(goal) {
  const marker = "参考内容：";
  const start = goal.indexOf(marker);
  const body = start >= 0 ? goal.slice(start + marker.length) : goal;
  return body.replace(/^\s*#\s*/, "").replace(/\s*:::\s*$/, "").split(/\r?\n/)
    .map((line) => normalizedText(line))
    .filter(Boolean);
}

const sourceRequest = JSON.parse(await readFile(requestPath, "utf8"));
const inputBytes = await readFile(inputPath);
const inputMime = actualMime(inputBytes);
assert.equal(typeof sourceRequest.intentPrompt, "string", "request.json 缺少 intentPrompt");
assert.ok(sourceRequest.intentPrompt.includes("详情页"), "本 E2E 只允许详情页目标");
assert.equal(sourceRequest.references?.length, 1, "本 E2E 要求恰好一张显式参考图");
assert.equal(sourceRequest.references[0].sha256, sha256(inputBytes), "request.json 与参考图 SHA-256 不一致");
assert.equal(sourceRequest.references[0].mime, inputMime, "request.json 与参考图 MIME 不一致");

let account;
let runId;
let cleanupKeys = [];
const startedAt = Date.now();
const outputDirectory = path.join(cloudDirectory, "artifacts");
try {
  account = await createAccount();
  const referenceArtifactId = randomUUID();
  const manifestObject = {
    schemaVersion: 1,
    goal: sourceRequest.intentPrompt,
    references: [{
      artifactId: referenceArtifactId,
      token: sourceRequest.references[0].token ?? "@图1",
      ordinal: 1,
      mime: inputMime,
      bytes: inputBytes.byteLength,
      sha256: sha256(inputBytes),
    }],
    htmlOutput: {
      viewport: { widthCssPx: 1080, heightCssPx: 900, deviceScaleFactor: 1 },
      capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1080, overlapCssPx: 0 },
      background: "opaque",
    },
  };
  const manifest = JSON.stringify(manifestObject);
  const created = await jsonRequest("创建统一 Agent Run", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({
      action: "create",
      skillId: "bowerbird-unified-agent",
      goal: sourceRequest.intentPrompt,
      inputCount: 1,
      inputManifestHash: sha256(manifest),
      agentRuntime: "dsh",
      idempotencyKey: `unified-agent-e2e-${randomBytes(8).toString("hex")}`,
    }),
  });
  runId = created.runId;
  console.log(`UNIFIED_RUN_CREATED run=${runId}`);
  assert.equal(created.agentRuntime, "dsh", "控制面没有锁定 DSH runtime");
  assert.equal(created.budgetCredits, 30, "统一 Agent test-only 预算应为 30 积分");
  assert.equal(created.inputUploads?.length, 1, "统一 Agent 应获得一个参考图上传地址");

  const manifestUpload = await fetch(created.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-upsert": "true" },
    body: manifest,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(manifestUpload.ok, true, `request.json 上传失败：${manifestUpload.status}`);
  const imageUpload = await fetch(created.inputUploads[0].uploadUrl, {
    method: "PUT",
    headers: { "content-type": inputMime, "x-upsert": "true" },
    body: inputBytes,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(imageUpload.ok, true, `参考图上传失败：${imageUpload.status}`);
  await jsonRequest("统一 Agent Run 入队", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "enqueue", runId }),
  });

  const approvalSnapshot = await waitFor(account.headers, runId, "awaiting_approval");
  assert.equal(approvalSnapshot.run.skill_id, "bowerbird-unified-agent");
  assert.equal(approvalSnapshot.run.agent_runtime, "dsh");
  const approval = approvalSnapshot.approvals.find((item) => item.status === "pending");
  assert.ok(approval?.proposal, "待审批统一计划正文缺失");
  const stepKinds = approval.proposal.steps?.map((step) => step.kind);
  assert.deepEqual(
    stepKinds,
    ["compose_html", "render_html", "inspect_artifact", "finalize_output"],
    "DSH 未自主选择严格 HTML 四工具链；停止在批准和 Seedream/renderer 副作用之前",
  );
  assert.equal(stepKinds.includes("generate_image"), false, "详情页计划不得调用 generate_image");
  console.log(`UNIFIED_PLAN_GATE_OK run=${runId} tools=${stepKinds.join("->")}`);

  await jsonRequest("批准统一计划", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "approve", approvalId: approval.id }),
  });

  const resultSnapshot = await waitFor(account.headers, runId, "awaiting_result_feedback");
  assert.ok(resultSnapshot.renderManifest?.outputs?.length >= 2, "统一 Agent 快照缺少 renderer 输出");
  const artifacts = await tableRows(
    "agent_artifacts",
    runId,
    "id,kind,role,object_key,mime,bytes,sha256,user_visible,source_call_id",
  );
  cleanupKeys = artifacts.map((artifact) => artifact.object_key);
  const byRole = (role) => artifacts.filter((artifact) => artifact.role === role);
  assert.equal(byRole("input").length, 1, "应登记一张显式输入图");
  assert.equal(byRole("input")[0].id, referenceArtifactId, "manifest 与服务端输入 artifact id 不一致");
  assert.equal(byRole("html_document").length, 1, "应登记唯一 HTML 文档");
  assert.equal(byRole("render_manifest").length, 1, "应登记唯一 render manifest");
  assert.equal(byRole("full_page_screenshot").length, 1, "应登记唯一整页截图");
  assert.ok(byRole("slice_screenshot").length >= 1, "应至少登记一张切片截图");
  assert.ok(byRole("diagnostic").length >= 2, "规划理解与结果检查应登记 Vision diagnostic");
  assert.equal(byRole("final_result").length, 0, "HTML finalize 不应伪造额外图片 artifact");

  await mkdir(outputDirectory, { recursive: true });
  const htmlBytes = await downloadArtifact(byRole("html_document")[0]);
  const html = htmlBytes.toString("utf8");
  const savedFiles = [];
  const saveArtifact = async (artifact, suffix) => {
    const bytes = artifact === byRole("html_document")[0] ? htmlBytes : await downloadArtifact(artifact);
    const file = path.join(outputDirectory, `unified-agent-e2e-${runId}-${suffix}`);
    await writeFile(file, bytes);
    savedFiles.push(file);
    return bytes;
  };
  await saveArtifact(byRole("html_document")[0], "document.html");
  const fullPageBytes = await saveArtifact(byRole("full_page_screenshot")[0], "full-page.png");
  assert.deepEqual([...fullPageBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "整页产物不是 PNG");
  for (const artifact of byRole("slice_screenshot").sort((left, right) => left.object_key.localeCompare(right.object_key))) {
    const index = artifact.object_key.match(/(\d+)(?=\.[^.]+$)/)?.[1] ?? savedFiles.length;
    await saveArtifact(artifact, `slice-${index}.png`);
  }
  const renderManifestBytes = await saveArtifact(byRole("render_manifest")[0], "render-manifest.json");
  const renderManifest = JSON.parse(renderManifestBytes.toString("utf8"));
  assert.match(renderManifest.rendererFingerprint, /^bwr1-[0-9a-f]{32}$/);
  assert.equal(renderManifest.outputs.length, byRole("full_page_screenshot").length + byRole("slice_screenshot").length);
  const plainText = htmlPlainText(html);
  const missingCopy = exactCopyLines(sourceRequest.intentPrompt).filter((line) => !plainText.includes(line));
  assert.deepEqual(missingCopy, [], `HTML 未逐行保留完整文案（缺失 ${missingCopy.length} 段）`);

  const checkpointRows = await jsonRequest("读取统一 Agent checkpoint", restUrl(
    "agent_runs",
    `id=eq.${encodeURIComponent(runId)}&select=checkpoint_object_key,checkpoint_hash`,
  ), { method: "GET", headers: adminHeaders });
  const checkpointRow = checkpointRows[0];
  assert.ok(checkpointRow?.checkpoint_object_key && checkpointRow?.checkpoint_hash, "统一 Agent checkpoint 身份缺失");
  const checkpointResponse = await fetch(storageUrl(checkpointRow.checkpoint_object_key), {
    headers: adminHeaders,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(checkpointResponse.ok, true, `checkpoint 下载失败：${checkpointResponse.status}`);
  const checkpointBytes = Buffer.from(await checkpointResponse.arrayBuffer());
  assert.equal(sha256(checkpointBytes), checkpointRow.checkpoint_hash, "checkpoint SHA-256 不一致");
  const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
  assert.equal(checkpoint.phase, "awaiting_result_feedback");
  assert.deepEqual(
    checkpoint.completedToolResults.map((item) => item.toolName),
    ["compose_html", "render_html", "inspect_artifact", "finalize_output"],
    "checkpoint 未记录完整四工具执行结果",
  );
  assert.equal(checkpoint.completedToolResults.at(-1)?.result?.primaryArtifactId, byRole("full_page_screenshot")[0].id);

  const toolCalls = await tableRows(
    "agent_tool_calls",
    runId,
    "call_id,phase,tool_name,args_hash,attempt,status,result_hash,safe_error_code,started_at",
  );
  const succeededToolCount = (name) => toolCalls.filter((call) => call.tool_name === name && call.status === "succeeded").length;
  for (const name of ["compose_html", "render_html", "inspect_artifact"]) {
    assert.equal(succeededToolCount(name), 1, `${name} 应恰好成功一次`);
  }
  assert.equal(succeededToolCount("understand_asset"), 1, "规划阶段应恰好理解一次显式参考图");
  assert.equal(succeededToolCount("finalize_output"), 0, "finalize_output 是无副作用父进程裁决，不应伪造 durable ledger 行");
  assert.equal(toolCalls.some((call) => call.tool_name === "generate_image"), false, "执行阶段不得出现 generate_image");
  assert.equal(toolCalls.some((call) => ["failed", "outcome_unknown"].includes(call.status)), false, "不得有 failed/outcome_unknown tool call");
  for (const toolName of ["understand_asset", "inspect_artifact"]) {
    const call = toolCalls.find((item) => item.tool_name === toolName && item.status === "succeeded");
    assert.equal(
      byRole("diagnostic").filter((artifact) => artifact.source_call_id === call.call_id).length,
      1,
      `${toolName} 应恰好登记一份与 durable call 绑定的 Vision diagnostic`,
    );
  }

  const usage = await tableRows(
    "agent_usage_items",
    runId,
    "call_id,kind,provider,model,input_units,output_units,image_count,provider_cost_micros,credits,created_at",
  );
  const modelUsage = usage.filter((item) => item.kind === "model_tokens" && item.provider === "deepseek");
  const visionUsage = usage.filter((item) => item.kind === "vision_call" && item.provider === "ark");
  const renderUsage = usage.filter((item) => item.kind === "html_render" && item.provider === "renderer");
  assert.ok(modelUsage.length >= 2, "应登记真实 DeepSeek 规划/执行回合");
  assert.equal(visionUsage.length, 2, "understand_asset 与 inspect_artifact 应各调用一次 Ark Vision");
  assert.equal(renderUsage.length, 1, "render_html 应恰好调用一次 renderer");
  assert.equal(usage.some((item) => item.kind === "image_generation"), false, "详情页不得产生 Seedream usage");

  await jsonRequest("确认整页截图已接收", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "artifact_received", artifactId: byRole("full_page_screenshot")[0].id }),
  });
  await jsonRequest("接受统一 Agent 结果", functionUrl("agent-run"), {
    method: "POST",
    headers: account.headers,
    body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "accept" }),
  });
  const finished = await waitFor(account.headers, runId, "succeeded");
  const usageCredits = usage.reduce((sum, item) => sum + Number(item.credits), 0);
  assert.equal(finished.run.actual_credits, usageCredits, "Run 终态积分未与 usage ledger 对账");

  const summary = {
    schemaVersion: 1,
    runId,
    durationMs: Date.now() - startedAt,
    stepKinds,
    rendererFingerprint: renderManifest.rendererFingerprint,
    outputs: renderManifest.outputs.length,
    slices: byRole("slice_screenshot").length,
    exactCopyLines: exactCopyLines(sourceRequest.intentPrompt).length,
    deepseekTurns: modelUsage.length,
    deepseekInputTokens: modelUsage.reduce((sum, item) => sum + Number(item.input_units), 0),
    deepseekOutputTokens: modelUsage.reduce((sum, item) => sum + Number(item.output_units), 0),
    arkVisionCalls: visionUsage.length,
    rendererCalls: renderUsage.length,
    seedreamCalls: 0,
    credits: finished.run.actual_credits,
    providerCostMicros: usage.reduce((sum, item) => sum + Number(item.provider_cost_micros ?? 0), 0),
    savedFiles,
  };
  const summaryFile = path.join(outputDirectory, `unified-agent-e2e-${runId}-summary.json`);
  await writeFile(summaryFile, JSON.stringify(summary, null, 2), "utf8");
  console.log("UNIFIED_AGENT_E2E_OK");
  console.log(JSON.stringify({ ...summary, savedFiles: [...savedFiles, summaryFile] }));
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
} finally {
  if (runId && account?.headers) {
    try {
      const snapshot = await getRun(account.headers, runId);
      if (!["succeeded", "failed", "cancelled"].includes(snapshot.run?.status)) {
        await jsonRequest("取消未完成统一 Agent Run", functionUrl("agent-run"), {
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
