// Real controlled-image-edit E2E. DSH requires migration 0050, deployed
// agent-run / agent-worker Functions, and a VPS Agent consumer with both U4
// runtime-selection flags enabled. It prints the proposed plan and waits for
// explicit approval unless --yes is supplied.
//
// Usage:
//   $env:BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS='1'
//   node scripts/test-controlled-agent-e2e.mjs --runtime dsh --allow-real-provider-costs
//   node scripts/test-controlled-agent-e2e.mjs --runtime legacy_kernel --allow-real-provider-costs --reference D:\test-assets\synthetic.png
//   node scripts/test-controlled-agent-e2e.mjs --runtime dsh --allow-real-provider-costs --yes
//   node scripts/test-controlled-agent-e2e.mjs --runtime dsh --allow-real-provider-costs --yes --retry-text "背景更浅，主体保持不变"
//   node scripts/test-controlled-agent-e2e.mjs --runtime dsh --allow-real-provider-costs --reject-plan

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { evaluateControlledRecoveryEvidence } from "./controlled-agent-recovery-evidence.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log([
    "真实 controlled-image-edit E2E（会产生 DeepSeek / 方舟费用）",
    "",
    "必需：",
    "  --runtime legacy_kernel|dsh",
    "  --allow-real-provider-costs",
    "  BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS=1",
    "",
    "可选：--reference <path> --intent <text> --yes --reject-plan --retry-text <text> --expect-reclaim",
  ].join("\n"));
  process.exit(0);
}

const runtimeIndex = args.indexOf("--runtime");
const agentRuntime = runtimeIndex >= 0 ? args[runtimeIndex + 1] : null;
if (agentRuntime !== "legacy_kernel" && agentRuntime !== "dsh") {
  console.error("必须用 --runtime 明确选择 legacy_kernel 或 dsh；不允许隐式默认运行时");
  process.exit(2);
}
if (!args.includes("--allow-real-provider-costs") || process.env.BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS !== "1") {
  console.error("真实 E2E 已拒绝：必须同时传 --allow-real-provider-costs，并设置 BOWERBIRD_U4_ALLOW_REAL_PROVIDER_COSTS=1");
  process.exit(2);
}

const referenceIndex = args.indexOf("--reference");
const referencePath = referenceIndex >= 0 ? args[referenceIndex + 1] : null;
const autoApprove = args.includes("--yes");
const rejectPlan = args.includes("--reject-plan");
const intentIndex = args.indexOf("--intent");
const customIntent = intentIndex >= 0 ? args[intentIndex + 1] : null;
const retryTextIndex = args.indexOf("--retry-text");
const retryText = retryTextIndex >= 0 ? args[retryTextIndex + 1] : null;
const expectReclaim = args.includes("--expect-reclaim");
if (referenceIndex >= 0 && !referencePath) {
  console.error("--reference 后需要一个明确可测试、非私人图片路径");
  process.exit(2);
}
if (retryTextIndex >= 0 && !retryText) {
  console.error("--retry-text 后需要具体反馈");
  process.exit(2);
}
if (intentIndex >= 0 && !customIntent) {
  console.error("--intent 后需要具体的用户意图");
  process.exit(2);
}
if (expectReclaim && (rejectPlan || retryText)) {
  console.error("--expect-reclaim 只允许单次批准执行，不能与 --reject-plan 或 --retry-text 同用");
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

const env = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const baseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = env.SUPABASE_SECRET_KEY;
if (!baseUrl || !publishableKey || !secretKey) {
  console.error("缺少 apps/cloud/.env 中的 SUPABASE_URL / publishable / secret key");
  process.exit(2);
}

const adminHeaders = { apikey: secretKey, authorization: `Bearer ${secretKey}`, "content-type": "application/json" };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const functionUrl = (name) => `${baseUrl}/functions/v1/${name}`;

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

function actualMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("参考图必须是实际 PNG/JPEG/WebP，不能只靠扩展名");
}

async function createAccount() {
  const email = `controlled-agent-e2e-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `${randomBytes(16).toString("hex")}Aa1!`;
  const created = await jsonRequest("创建临时账号", `${baseUrl}/auth/v1/admin/users`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { bowerbird_test: true } }),
  }, [200, 201]);
  const session = await jsonRequest("临时账号登录", `${baseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    userId: created.id,
    headers: { apikey: publishableKey, authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
  };
}

async function grantTestCredits(authUserId) {
  const accounts = await jsonRequest("读取临时账号计费身份", `${baseUrl}/rest/v1/billing_accounts?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=id`, {
    method: "GET", headers: adminHeaders,
  });
  assert.equal(accounts.length, 1, "临时账号计费身份缺失");
  await jsonRequest("发放 Agent E2E 测试积分", `${baseUrl}/rest/v1/rpc/grant_topup_credits`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({
      p_user_id: accounts[0].id,
      p_order_id: `controlled-agent-e2e-${randomBytes(8).toString("hex")}`,
      p_amount: 48,
    }),
  });
}

async function getRun(headers, runId) {
  return await jsonRequest("查询 Agent Run", functionUrl("agent-run"), {
    method: "POST", headers, body: JSON.stringify({ action: "get", runId }),
  });
}

async function usageForRun(runId) {
  return await jsonRequest("读取 Agent usage", `${baseUrl}/rest/v1/agent_usage_items?run_id=eq.${encodeURIComponent(runId)}&select=call_id,kind,provider,credits`, {
    method: "GET", headers: adminHeaders,
  });
}

async function recoveryRunRow(runId) {
  const rows = await jsonRequest("读取 recovery Run 证据", `${baseUrl}/rest/v1/agent_runs?id=eq.${encodeURIComponent(runId)}&select=status,current_step,lease_id,agent_runtime,actual_credits`, {
    method: "GET", headers: adminHeaders,
  });
  assert.equal(rows.length, 1, "recovery Run 证据缺失");
  return rows[0];
}

async function toolCallsForRun(runId) {
  return await jsonRequest("读取 Agent tool ledger", `${baseUrl}/rest/v1/agent_tool_calls?run_id=eq.${encodeURIComponent(runId)}&select=call_id,phase,tool_name,status,result_hash`, {
    method: "GET", headers: adminHeaders,
  });
}

async function waitFor(headers, runId, wanted, maxWaitMs = 12 * 60_000, observe) {
  const started = Date.now();
  for (;;) {
    const snapshot = await getRun(headers, runId);
    const status = snapshot.run?.status;
    assert.equal(snapshot.run?.agent_runtime, agentRuntime, "Run 快照中的 Agent runtime 漂移或缺失");
    if (observe) await observe(snapshot);
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
    // Recovery orchestration must observe the first post-approval lease before
    // the Worker can submit the provider request. Keep normal E2E polling
    // conservative, but tighten only the explicit crash/re-claim window.
    await new Promise((resolve) => setTimeout(resolve, observe ? 250 : 3_000));
  }
}

async function downloadFinal(headers, runId, snapshot, label = "final") {
  const finalArtifact = snapshot.artifacts.find((item) => item.role === "final_result");
  assert.ok(finalArtifact, "未登记 final_result");
  assert.equal(snapshot.artifacts.filter((item) => item.role === "final_result").length, 1, "final_result 必须恰有一个");
  const signed = await jsonRequest("签发最终图下载地址", functionUrl("agent-run"), {
    method: "POST", headers, body: JSON.stringify({ action: "artifact_url", artifactId: finalArtifact.id }),
  });
  const imageResponse = await fetch(signed.url, { signal: AbortSignal.timeout(60_000) });
  assert.equal(imageResponse.ok, true, `最终图下载失败：${imageResponse.status}`);
  const finalBytes = Buffer.from(await imageResponse.arrayBuffer());
  assert.equal(finalBytes.byteLength, finalArtifact.bytes);
  assert.equal(sha256(finalBytes), finalArtifact.sha256, "最终图 SHA-256 不一致");
  const outputDirectory = new URL("../artifacts/", import.meta.url);
  await mkdir(outputDirectory, { recursive: true });
  const suffix = finalArtifact.mime === "image/jpeg" ? "jpg" : finalArtifact.mime === "image/webp" ? "webp" : "png";
  const outputFile = new URL(`controlled-agent-e2e-${runId}-${label}.${suffix}`, outputDirectory);
  await writeFile(outputFile, finalBytes);
  console.log(`最终图已保存：${outputFile.pathname}`);
  return finalArtifact;
}

let account;
let runId;
const e2eStartedAt = Date.now();
try {
  account = await createAccount();
  // A fresh account has 30 daily credits, while this POC Run reserves a
  // 48-credit maximum. Grant isolated test-only topup credit without changing
  // production pricing or the normal signup allowance.
  await grantTestCredits(account.userId);
  const references = [];
  let referenceBytes;
  if (referencePath) {
    referenceBytes = await readFile(referencePath);
    references.push({
      referenceId: "ref-1", token: "@图1", ordinal: 1, mime: actualMime(referenceBytes),
      bytes: referenceBytes.byteLength, sha256: sha256(referenceBytes),
    });
  }
  const intentPrompt = customIntent ?? (referencePath
    ? "以 @图1 为唯一主体与底图，严格保持主体结构和身份，只把背景改为干净的浅蓝摄影棚背景；不要加入文字、logo 或其他物体。"
    : "生成一张干净的浅蓝极简摄影棚背景图，不要文字、logo、人物或产品，横向构图。");
  const generatedAt = new Date();
  const preferenceCapsule = {
    schemaVersion: 1,
    scope: {},
    preferred: [{ category: "palette", value: "偏好干净、低饱和的浅色背景", confidence: 1, evidenceCount: 1, explicit: true }],
    avoid: [{ category: "avoid", value: "避免文字和 logo", confidence: 1, evidenceCount: 1, explicit: true }],
    workflow: [],
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
  };
  const manifest = JSON.stringify({ schemaVersion: 1, intentPrompt, references, ratio: "16:9", preferenceCapsule });
  const created = await jsonRequest("创建受控 Agent Run", functionUrl("agent-run"), {
    method: "POST", headers: account.headers,
    body: JSON.stringify({
      action: "create", skillId: "bowerbird-controlled-image-edit", goal: intentPrompt,
      inputCount: references.length, inputManifestHash: sha256(manifest), ratio: "16:9",
      agentRuntime,
      idempotencyKey: `controlled-e2e-${agentRuntime}-${randomBytes(8).toString("hex")}`,
    }),
  });
  assert.equal(created.agentRuntime, agentRuntime, "控制面没有锁定请求的 Agent runtime；停止在任何 provider 调用之前");
  runId = created.runId;
  const requestUpload = await fetch(created.uploadUrl, {
    method: "PUT", headers: { "content-type": "application/json", "x-upsert": "true" }, body: manifest,
  });
  assert.equal(requestUpload.ok, true, `request.json 上传失败：${requestUpload.status}`);
  if (referenceBytes) {
    assert.equal(created.inputUploads?.length, 1, "控制面未返回参考图上传地址");
    const imageUpload = await fetch(created.inputUploads[0].uploadUrl, {
      method: "PUT", headers: { "content-type": references[0].mime, "x-upsert": "true" }, body: referenceBytes,
    });
    assert.equal(imageUpload.ok, true, `参考图上传失败：${imageUpload.status}`);
  }
  await jsonRequest("受控 Run 入队", functionUrl("agent-run"), {
    method: "POST", headers: account.headers, body: JSON.stringify({ action: "enqueue", runId }),
  });

  const approvalSnapshot = await waitFor(account.headers, runId, "awaiting_approval");
  const approval = approvalSnapshot.approvals.find((item) => item.status === "pending");
  assert.ok(approval?.proposal, "待审批计划正文缺失");
  console.log("\n--- Agent 提议的完整计划 ---");
  console.log(JSON.stringify(approval.proposal, null, 2));
  console.log(`预计图片调用：${approval.planned_tool_count}；最大追加积分：${approval.estimated_additional_credits}`);
  if (rejectPlan) {
    await jsonRequest("拒绝计划", functionUrl("agent-run"), {
      method: "POST", headers: account.headers, body: JSON.stringify({ action: "reject", approvalId: approval.id }),
    });
    const cancelled = await getRun(account.headers, runId);
    assert.equal(cancelled.run.status, "cancelled", "拒绝计划后 Run 必须终止");
    const usage = await usageForRun(runId);
    const usageCredits = usage.reduce((sum, item) => sum + Number(item.credits), 0);
    const modelTurns = usage.filter((item) => item.kind === "model_tokens" && item.provider === "deepseek");
    assert.ok(modelTurns.length >= 2 && modelTurns.length <= 4, "首次分析/规划应登记 2–4 个 DeepSeek 文本回合");
    assert.equal(cancelled.run.actual_credits, usageCredits, "拒绝后实际积分必须等于服务端 usage 汇总");
    console.log("CONTROLLED_AGENT_REJECT_E2E_OK");
    console.log(`runtime=${agentRuntime} run=${runId} conversation=${cancelled.conversationId} credits=${cancelled.run.actual_credits}`);
  }
  if (!rejectPlan) {
  if (!autoApprove) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("\n确认计划合理并执行？输入 yes：");
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") throw new Error("用户未批准计划，测试停止");
  }
  await jsonRequest("批准计划", functionUrl("agent-run"), {
    method: "POST", headers: account.headers, body: JSON.stringify({ action: "approve", approvalId: approval.id }),
  });

  const executionLeaseIds = new Set();
  let announcedExecutionLeaseCount = 0;
  const observeExecutionRecovery = expectReclaim ? async () => {
    const row = await recoveryRunRow(runId);
    assert.equal(row.agent_runtime, agentRuntime, "执行阶段持久化 runtime 漂移");
    if (typeof row.lease_id === "string" && row.lease_id) executionLeaseIds.add(row.lease_id);
    if (executionLeaseIds.size > announcedExecutionLeaseCount) {
      announcedExecutionLeaseCount = executionLeaseIds.size;
      if (announcedExecutionLeaseCount === 1) {
        console.log("\nRECOVERY_FIRST_EXECUTION_LEASE_OBSERVED：现在必须由外部测试编排使候选 Worker 真实退出并重启；脚本本身不会杀进程。");
      } else {
        console.log(`\nRECOVERY_EXECUTION_RECLAIM_OBSERVED count=${announcedExecutionLeaseCount}`);
      }
    }
  } : undefined;
  let resultSnapshot = await waitFor(
    account.headers,
    runId,
    "awaiting_result_feedback",
    12 * 60_000,
    observeExecutionRecovery,
  );
  let finalArtifact = await downloadFinal(account.headers, runId, resultSnapshot, "initial");
  if (retryText) {
    await jsonRequest("提交结果重试反馈", functionUrl("agent-run"), {
      method: "POST", headers: account.headers,
      body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "retry", text: retryText }),
    });
    const revisionSnapshot = await waitFor(account.headers, runId, "awaiting_approval");
    const revision = revisionSnapshot.approvals.find((item) => item.status === "pending");
    assert.ok(revision?.proposal, "待审批修订计划正文缺失");
    console.log("\n--- Agent 提议的修订计划 ---");
    console.log(JSON.stringify(revision.proposal, null, 2));
    console.log(`修订图片调用：${revision.planned_tool_count}；最大追加积分：${revision.estimated_additional_credits}`);
    if (!autoApprove) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("\n确认修订计划合理并执行？输入 yes：");
      rl.close();
      if (answer.trim().toLowerCase() !== "yes") throw new Error("用户未批准修订计划，测试停止");
    }
    await jsonRequest("批准修订计划", functionUrl("agent-run"), {
      method: "POST", headers: account.headers, body: JSON.stringify({ action: "approve", approvalId: revision.id }),
    });
    resultSnapshot = await waitFor(account.headers, runId, "awaiting_result_feedback");
    finalArtifact = await downloadFinal(account.headers, runId, resultSnapshot, "revision-1");
  }
  await jsonRequest("确认最终图已接收", functionUrl("agent-run"), {
    method: "POST", headers: account.headers, body: JSON.stringify({ action: "artifact_received", artifactId: finalArtifact.id }),
  });
  await jsonRequest("接受结果", functionUrl("agent-run"), {
    method: "POST", headers: account.headers,
    body: JSON.stringify({ action: "result_feedback", runId, feedbackAction: "accept" }),
  });
  const finished = await waitFor(account.headers, runId, "succeeded");
  const usage = await usageForRun(runId);
  const usageCredits = usage.reduce((sum, item) => sum + Number(item.credits), 0);
  assert.equal(
    finished.run.actual_credits,
    usageCredits,
    "Run 终态必须与服务端 usage ledger 完成积分对账",
  );
  console.log("CONTROLLED_AGENT_E2E_OK");
  console.log(`runtime=${agentRuntime} run=${runId} conversation=${finished.conversationId} artifacts=${finished.artifacts.length} credits=${finished.run.actual_credits}`);
  if (expectReclaim) {
    const persisted = await recoveryRunRow(runId);
    const toolCalls = await toolCallsForRun(runId);
    const finalArtifactCount = finished.artifacts.filter((item) => item.role === "final_result").length;
    const evidence = evaluateControlledRecoveryEvidence({
      requestedRuntime: agentRuntime,
      persistedRuntime: persisted.agent_runtime,
      executionLeaseIds: [...executionLeaseIds],
      toolCalls,
      usageItems: usage,
      plannedToolCount: Number(approval.planned_tool_count),
      finalArtifactCount,
      finalStatus: persisted.status,
      actualCredits: Number(persisted.actual_credits),
      durationMs: Date.now() - e2eStartedAt,
    });
    assert.equal(evidence.recoverySuccess, true, `真实 recovery 证据未闭合：${JSON.stringify(evidence.checks)}`);
    const generatedAt = new Date().toISOString();
    const recoveryReport = {
      schemaVersion: 1,
      generatedAt,
      source: "controlled-agent-real-recovery-e2e",
      runId,
      evidence,
      observations: [{
        caseId: "real-controlled-image-recovery-v1",
        runtime: agentRuntime,
        strategyCorrect: null,
        structuredSuccess: true,
        durationMs: evidence.durationMs,
        credits: evidence.actualCredits,
        recoverySuccess: true,
        costBasis: "actual",
      }],
    };
    const outputDirectory = new URL("../artifacts/", import.meta.url);
    await mkdir(outputDirectory, { recursive: true });
    const outputFile = new URL(`controlled-runtime-recovery-${agentRuntime}-${runId}.json`, outputDirectory);
    await writeFile(outputFile, JSON.stringify(recoveryReport, null, 2), "utf8");
    console.log("CONTROLLED_AGENT_RECOVERY_E2E_OK");
    console.log(`recovery_report=${outputFile.pathname}`);
  }
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
} finally {
  if (account?.userId) {
    try {
      await fetch(`${baseUrl}/auth/v1/admin/users/${account.userId}`, {
        method: "DELETE", headers: adminHeaders, signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Best effort; all objects also have TTL cleanup.
    }
  }
}
