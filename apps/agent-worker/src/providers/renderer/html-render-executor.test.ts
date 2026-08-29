/**
 * HtmlRenderExecutor 测试 —— H2-T2/T4。
 * 覆盖：happy path 多 artifact 上传（整页/切片/manifest/usage/ledger）、
 * 提交后崩溃恢复（同进程内存命中 / 跨进程确定性重算 + 内容寻址幂等）、
 * renderer kill → outcome_unknown → 重 claim 重算、稳定 400 终态不重试、
 * 跨 Run/缺资源在 renderer 之前被拒、回显字段不符 fail closed。
 * （与 apps/html-renderer 的 wire 契约镜像由该包内的 wire-mirror.test.ts 钉死。）
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { after, test } from "node:test";

import { AgentControlError, type PreparedToolCall, type RegisteredAgentArtifact } from "../../control-plane/agent-control-client.ts";
import { DurableProviderError, SimulatedProcessCrash, type DurableToolIdentity } from "../../kernel/durable-tool-dispatcher.ts";
import { computeArgsHash } from "../../kernel/tool-ledger.ts";
import { base64Decode, validateRenderHtmlInput, type RenderHtmlInputV1, type RendererWireRequest, type RendererWireSuccess } from "../../contracts/render-html.ts";
import { createHtmlRenderExecutor, type HtmlRenderControl, type HtmlRenderWorkspace } from "./html-render-executor.ts";

const RUN_ID = "run-render-1";
const LEASE_ID = "lease-1";
const CALL_ID = computeArgsHash({ seed: "call" });

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 1×1 PNG（与 ark executor 同款 fixture 字节）。 */
const ONE_PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_PNG = base64Decode(ONE_PIXEL_PNG_B64);

const storedBytes = new Map<string, Uint8Array>();

type UploadArgs = Parameters<HtmlRenderControl["uploadArtifact"]>[0];

class MemoryRenderControl implements HtmlRenderControl {
  readonly rows = new Map<string, PreparedToolCall & { argsHash: string }>();
  readonly artifacts = new Map<string, RegisteredAgentArtifact>();
  readonly usage: Array<Record<string, unknown>> = [];
  private artifactSeq = 0;

  async prepareTool(args: DurableToolIdentity & { argsHash: string }): Promise<PreparedToolCall> {
    const existing = this.rows.get(args.callId);
    if (existing) {
      if (existing.argsHash !== args.argsHash) throw new Error("call_id_args_hash_conflict");
      return { ...existing, reused: true };
    }
    const row = { callId: args.callId, status: "prepared" as const, reused: false, argsHash: args.argsHash };
    this.rows.set(args.callId, row);
    return row;
  }

  async markToolSubmitted(args: { runId: string; leaseId: string; callId: string }): Promise<PreparedToolCall> {
    const row = this.required(args.callId);
    row.status = "submitted";
    return row;
  }

  async completeTool(args: { runId: string; leaseId: string; callId: string } & {
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string; resultHash?: string; safeErrorCode?: string;
  }): Promise<PreparedToolCall> {
    const row = this.required(args.callId);
    row.status = args.status;
    row.resultObjectKey = args.resultObjectKey;
    row.resultHash = args.resultHash;
    return row;
  }

  async uploadArtifact(args: UploadArgs): Promise<RegisteredAgentArtifact> {
    const name = args.outputName ?? "default";
    const ext = args.mime === "application/json" ? "json" : args.mime === "text/html" ? "html" : "png";
    const objectKey = `runs/${args.runId}/artifacts/${args.sourceCallId}-${name}.${ext}`;
    const existing = this.artifacts.get(objectKey);
    if (existing) {
      if (existing.sha256 !== args.sha256) throw new AgentControlError(409);
      return existing;
    }
    const artifact: RegisteredAgentArtifact = {
      artifactId: `art-${++this.artifactSeq}`,
      conversationId: "conv-1",
      runId: args.runId,
      role: args.role as RegisteredAgentArtifact["role"],
      stepId: args.stepId,
      parentArtifactId: args.parentArtifactId ?? null,
      mime: args.mime,
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: args.userVisible ?? true,
      url: `mem://${objectKey}`,
      objectKey,
    };
    this.artifacts.set(objectKey, artifact);
    storedBytes.set(objectKey, args.bytes);
    return artifact;
  }

  async getArtifactByCall(runId: string, _leaseId: string, callId: string, outputName?: string): Promise<RegisteredAgentArtifact> {
    const name = outputName ?? "default";
    const suffix = `/${callId}-${name}.`;
    for (const artifact of this.artifacts.values()) {
      if (artifact.runId === runId && artifact.objectKey.includes(suffix)) return artifact;
    }
    throw new AgentControlError(409);
  }

  async recordUsage(args: { runId: string; leaseId: string; callId: string; kind: string; provider: string; model: string; outputUnits?: number }): Promise<void> {
    this.usage.push({ ...args });
  }

  async downloadVerifiedBytes(url: string, expected: { sha256: string; bytes: number }): Promise<Uint8Array> {
    const objectKey = url.replace("mem://", "");
    const artifact = this.artifacts.get(objectKey);
    if (!artifact) throw new Error("memory_object_missing");
    if (artifact.sha256 !== expected.sha256) throw new Error("agent_object_hash_mismatch");
    return storedBytes.get(objectKey) ?? new Uint8Array();
  }

  private required(callId: string): PreparedToolCall & { argsHash: string } {
    const row = this.rows.get(callId);
    if (!row) throw new Error("missing_tool_row");
    return row;
  }
}

function fakeWorkspace(html: string): HtmlRenderWorkspace {
  return {
    async readArtifact() {
      return { mime: "image/png", bytes: ONE_PIXEL_PNG, sha256: sha256Hex(ONE_PIXEL_PNG) };
    },
    async readHtmlDocumentArtifact() {
      return html;
    },
  };
}

const HTML_DOC = "<!DOCTYPE html><html><body><div>中文海报</div></body></html>";

type RenderOutcome = { status: number; body: unknown } | { destroy: true };

/** 环回假 renderer：默认返回整页 + 两切片（全部 1×1 PNG 字节）；可插入一次性故障。 */
class FakeRendererServer {
  readonly requests: RendererWireRequest[] = [];
  renderCalls = 0;
  port = 0;
  private server: Server | undefined;
  private readonly failures: Array<(req: RendererWireRequest) => RenderOutcome> = [];

  pushFailure(step: (req: RendererWireRequest) => RenderOutcome): void {
    this.failures.push(step);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Uint8Array[] = [];
      req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      req.on("end", () => {
        const parsed = JSON.parse(new TextDecoder().decode(concat(chunks))) as RendererWireRequest;
        this.requests.push(parsed);
        this.renderCalls += 1;
        const failure = this.failures.shift();
        const outcome: RenderOutcome = failure ? failure(parsed) : { status: 200, body: this.successBody(parsed) };
        if ("destroy" in outcome) {
          res.destroy();
          return;
        }
        res.writeHead(outcome.status, { "content-type": "application/json" });
        res.end(JSON.stringify(outcome.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server!.address() as { port: number }).port;
  }

  successBody(req: RendererWireRequest): RendererWireSuccess {
    const output = (role: "full_page_screenshot" | "slice_screenshot", index?: number, y = 0, height = 1) => ({
      role,
      ...(index !== undefined ? { index } : {}),
      clipDevicePx: { x: 0, y, width: 1, height },
      mime: "image/png" as const,
      widthDevicePx: 1,
      heightDevicePx: 1,
      bytes: ONE_PIXEL_PNG.byteLength,
      sha256: sha256Hex(ONE_PIXEL_PNG),
      dataBase64: ONE_PIXEL_PNG_B64,
    });
    return {
      ok: true,
      schemaVersion: 1,
      rendererFingerprint: "bwr1-test",
      runId: req.runId,
      callId: req.callId,
      argsHash: req.argsHash,
      sourceHtmlSha256: sha256Hex(req.html),
      document: { widthCssPx: req.viewport.widthCssPx, heightCssPx: 300, widthDevicePx: req.viewport.widthCssPx, heightDevicePx: 300 },
      renderMs: 12,
      outputs: [output("full_page_screenshot"), output("slice_screenshot", 1, 0, 150), output("slice_screenshot", 2, 150, 150)],
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const fakeRenderer = new FakeRendererServer();
await fakeRenderer.start();

after(async () => {
  await fakeRenderer.stop();
});

function executorConfig() {
  return { rendererUrl: `http://127.0.0.1:${fakeRenderer.port}`, internalToken: "unit-test-renderer-token-0123456789" };
}

function validInput(): RenderHtmlInputV1 {
  const parsed = validateRenderHtmlInput({
    schemaVersion: 1,
    htmlArtifactId: "art-html-1",
    resourceArtifactIds: ["art-res-1"],
    viewport: { widthCssPx: 320, heightCssPx: 240, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 200 },
    background: "opaque",
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.violation.reason}`);
  return parsed.value;
}

function onceCrashAfterExecute(): { flag: { crash: boolean }; hook: () => void } {
  const flag = { crash: true };
  return { flag, hook: () => { if (flag.crash) { flag.crash = false; throw new SimulatedProcessCrash(); } } };
}

function makeExecutor(control: MemoryRenderControl, afterExecute?: () => void) {
  return createHtmlRenderExecutor({
    runId: RUN_ID,
    leaseId: LEASE_ID,
    control,
    workspace: fakeWorkspace(HTML_DOC),
    config: executorConfig(),
    ...(afterExecute ? { options: { afterExecute } } : {}),
  });
}

test("happy path: full page + slices + manifest artifacts, usage and ledger", async () => {
  const control = new MemoryRenderControl();
  const executor = makeExecutor(control);
  const result = await executor.render({
    callId: CALL_ID,
    phase: "render_once",
    input: validInput(),
    stepId: "step-render",
  });
  equal(result.outputs.length, 3);
  equal(result.outputs[0]!.role, "full_page_screenshot");
  equal(result.outputs[1]!.role, "slice_screenshot");
  equal(result.outputs[1]!.index, 1);
  ok(!result.outputs[0]!.artifactId.startsWith("pending:"));
  equal(result.rendererFingerprint, "bwr1-test");

  const manifestKey = `runs/${RUN_ID}/artifacts/${CALL_ID}-manifest.json`;
  equal(result.manifestObjectKey, manifestKey);
  const row = control.rows.get(CALL_ID);
  equal(row?.status, "succeeded");
  equal(row?.resultObjectKey, manifestKey);
  ok(/^[0-9a-f]{64}$/.test(row?.resultHash ?? ""));

  const full = control.artifacts.get(`runs/${RUN_ID}/artifacts/${CALL_ID}-full.png`)!;
  const slice1 = control.artifacts.get(`runs/${RUN_ID}/artifacts/${CALL_ID}-slice-0001.png`)!;
  const slice2 = control.artifacts.get(`runs/${RUN_ID}/artifacts/${CALL_ID}-slice-0002.png`)!;
  const manifest = control.artifacts.get(manifestKey)!;
  ok(full && slice1 && slice2 && manifest);
  equal(manifest.userVisible, false);
  equal(full.userVisible, true);
  equal(slice1.parentArtifactId, full.artifactId);
  equal(slice2.parentArtifactId, full.artifactId);
  equal(slice1.stepId, "step-render");

  equal(control.usage.length, 1);
  equal(control.usage[0]!.kind, "html_render");
  equal(control.usage[0]!.provider, "renderer");
  equal(control.usage[0]!.outputUnits, 3);

  const manifestJson = JSON.parse(new TextDecoder().decode(storedBytes.get(manifestKey)!)) as {
    outputs: Array<{ clipDevicePx: { x: number; y: number; width: number; height: number } }>;
  };
  deepEqual(manifestJson.outputs[2]!.clipDevicePx, { x: 0, y: 150, width: 1, height: 150 });
});

test("crash after renderer success resumes from in-memory result without a second render", async () => {
  const callId = computeArgsHash({ seed: "call2" });
  const control = new MemoryRenderControl();
  const crash = onceCrashAfterExecute();
  const executor = makeExecutor(control, crash.hook);
  const callsBefore = fakeRenderer.renderCalls;
  await rejects(() => executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }), /simulated_process_crash/);
  equal(control.rows.get(callId)?.status, "submitted");
  equal(fakeRenderer.renderCalls, callsBefore + 1);

  // 同一进程恢复：computed 内存命中 → 不再渲染，直接 persist
  const result = await executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" });
  equal(result.outputs.length, 3);
  equal(fakeRenderer.renderCalls, callsBefore + 1, "内存命中，零额外渲染");
  equal(control.rows.get(callId)?.status, "succeeded");
  equal(control.artifacts.size, 4);
});

test("process death (memory lost): deterministic recompute keeps artifacts idempotent", async () => {
  const callId = computeArgsHash({ seed: "call3" });
  const control = new MemoryRenderControl();
  const crash = onceCrashAfterExecute();
  const first = makeExecutor(control, crash.hook);
  await rejects(() => first.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }), /simulated_process_crash/);

  // 新进程：内存丢失 → reconcile 查 ledger 无 manifest → 确定性重算
  const callsBefore = fakeRenderer.renderCalls;
  const second = makeExecutor(control);
  const result = await second.render({ callId, phase: "render_once", input: validInput(), stepId: "s" });
  equal(result.outputs.length, 3);
  equal(fakeRenderer.renderCalls, callsBefore + 1, "跨进程恢复需重算一次");
  equal(control.artifacts.size, 4, "整页+两切片+manifest，重算不产生重复 artifact");
  equal(control.usage.length, 1, "usage 不重复计量");
});

test("renderer connection killed twice parks as outcome_unknown; retry after re-claim recomputes", async () => {
  const callId = computeArgsHash({ seed: "call4" });
  fakeRenderer.pushFailure(() => ({ destroy: true }));
  fakeRenderer.pushFailure(() => ({ destroy: true }));
  const control = new MemoryRenderControl();
  const executor = makeExecutor(control);
  await rejects(() => executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }), DurableProviderError);
  equal(control.rows.get(callId)?.status, "outcome_unknown");
  equal(control.artifacts.size, 0);

  // 重 claim（submitted/outcome_unknown → reconcile）：ledger 无结果 → 确定性重算
  const resumed = makeExecutor(control);
  const result = await resumed.render({ callId, phase: "render_once", input: validInput(), stepId: "s" });
  equal(result.outputs.length, 3);
  equal(control.rows.get(callId)?.status, "succeeded");
});

test("definitive renderer 400 fails terminal without retry", async () => {
  const callId = computeArgsHash({ seed: "call5" });
  fakeRenderer.pushFailure(() => ({ status: 400, body: { ok: false, code: "render_html_unsafe", message: "x", retryable: false } }));
  const control = new MemoryRenderControl();
  const executor = makeExecutor(control);
  const callsBefore = fakeRenderer.renderCalls;
  const error = await executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  ok(error instanceof DurableProviderError, `expected DurableProviderError, got ${String(error)}`);
  equal((error as DurableProviderError).safeCode, "render_html_unsafe");
  equal(control.rows.get(callId)?.status, "failed");
  equal(fakeRenderer.renderCalls, callsBefore + 1, "非可重试错误不得重试");
});

test("workspace miss (foreign artifact id) never reaches renderer", async () => {
  const callId = computeArgsHash({ seed: "call6" });
  const control = new MemoryRenderControl();
  const executor = createHtmlRenderExecutor({
    runId: RUN_ID,
    leaseId: LEASE_ID,
    control,
    workspace: {
      readArtifact: async () => {
        throw new Error("agent_workspace_artifact_url_missing");
      },
      readHtmlDocumentArtifact: async () => HTML_DOC,
    },
    config: executorConfig(),
  });
  const callsBefore = fakeRenderer.renderCalls;
  const error = await executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  ok(error instanceof DurableProviderError);
  equal((error as DurableProviderError).safeCode, "render_resource_invalid");
  equal(fakeRenderer.renderCalls, callsBefore, "renderer 零调用");
  equal(control.rows.get(callId)?.status, "failed");
});

test("renderer 429/503 are retried once then parked as outcome_unknown; re-claim recomputes", async () => {
  // 第一次 render：429 两次（executor 内单次重试也耗尽）→ outcome_unknown，零 artifact。
  const callId = computeArgsHash({ seed: "call-busy" });
  fakeRenderer.pushFailure(() => ({ status: 429, body: { ok: false, code: "render_capacity_busy", message: "busy", retryable: true } }));
  fakeRenderer.pushFailure(() => ({ status: 503, body: { ok: false, code: "render_service_unavailable", message: "down", retryable: true } }));
  const control = new MemoryRenderControl();
  const executor = makeExecutor(control);
  const callsBefore = fakeRenderer.renderCalls;
  const error = await executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  ok(error instanceof DurableProviderError);
  equal((error as DurableProviderError).safeCode, "render_capacity_busy", "保留首个可重试错误码");
  equal(control.rows.get(callId)?.status, "outcome_unknown");
  equal(control.artifacts.size, 0);
  equal(fakeRenderer.renderCalls, callsBefore + 2, "有界重试恰好一次");

  // renderer 恢复后重 claim：reconcile 无 ledger 结果 → 确定性重算成功。
  const resumed = makeExecutor(control);
  const result = await resumed.render({ callId, phase: "render_once", input: validInput(), stepId: "s" });
  equal(result.outputs.length, 3);
  equal(control.rows.get(callId)?.status, "succeeded");
});

test("renderer echo mismatch (runId) fails closed as output invalid", async () => {
  const callId = computeArgsHash({ seed: "call7" });
  fakeRenderer.pushFailure((req) => {
    const body = fakeRenderer.successBody({ ...req, runId: "other-run" });
    return { status: 200, body };
  });
  const control = new MemoryRenderControl();
  const executor = makeExecutor(control);
  const error = await executor.render({ callId, phase: "render_once", input: validInput(), stepId: "s" }).then(
    () => undefined,
    (e: unknown) => e,
  );
  ok(error instanceof DurableProviderError);
  equal((error as DurableProviderError).safeCode, "render_output_invalid");
});

test("model input schema: url/path/extra fields rejected before executor", () => {
  ok(!validateRenderHtmlInput({ ...validInput(), url: "https://evil.example" } as never).ok);
  ok(!validateRenderHtmlInput({ ...validInput(), html: "<script/>" } as never).ok);
  ok(!validateRenderHtmlInput({ ...validInput(), resourceArtifactIds: ["../etc/passwd"] }).ok);
  ok(!validateRenderHtmlInput({ ...validInput(), capture: { mode: "full_page", overlapCssPx: 10 } }).ok);
  ok(validateRenderHtmlInput(validInput()).ok);
});
