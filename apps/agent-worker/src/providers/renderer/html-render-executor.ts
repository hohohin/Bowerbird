/**
 * HtmlRenderExecutor —— HTML-RENDER-PLAN.md H2-T2/T3/T4。
 *
 * 把 Kernel 的 `render_html` 工具调用接入 durable tool 生命周期：
 *   tool_prepare → tool_submitted → 读当前 Run 的 html_document + 资源 artifact（归属闭集）
 *     → 有界内部请求调 html-renderer 容器（Bearer 共享 secret）
 *     → 复核 PNG（签名/IHDR 尺寸/sha/字节）与 manifest 回显字段
 *     → 上传 manifest + 全部 PNG artifact（同 call 多输出，outputName 判别）
 *     → 技术 usage（html_render，0 积分）→ tool_complete →（checkpoint 由 runner）
 *
 * 恢复语义（§6.1）：renderer 是可安全重算的确定性计算——
 *   - duplicate dispatch / 已 succeeded → 从 manifest artifact 下载重建（sha 复核）；
 *   - 提交后连接丢失 / persist 中途崩溃 → ledger 查 manifest，缺失时以同一 call id 重算，
 *     依赖同 fingerprint 下渲染字节可复现 + artifact 按 (call, outputName) 内容寻址幂等。
 *
 * 模型构造的 URL/路径/跨 Run artifact/额外字段在进入本执行器前已被
 * validateRenderHtmlInput + workspace 归属复核拒绝，永远到不了 renderer。
 */
import { createHash } from "node:crypto";

import type { AgentWorkerFetch, HttpResponse, PreparedToolCall, RegisteredAgentArtifact } from "../../control-plane/agent-control-client.ts";
import { AgentControlError } from "../../control-plane/agent-control-client.ts";
import {
  DurableProviderError,
  DurableToolDispatcher,
  SimulatedProcessCrash,
  type DurableToolAdapter,
  type DurableToolControl,
  type DurableToolIdentity,
} from "../../kernel/durable-tool-dispatcher.ts";
import { computeArgsHash } from "../../kernel/tool-ledger.ts";
import type {
  RenderHtmlInputV1,
  RenderHtmlResultV1,
  RendererWireFailure,
  RendererWireRequest,
  RendererWireSuccess,
} from "../../contracts/render-html.ts";
import { base64Decode, base64Encode } from "../../contracts/render-html.ts";

/** 执行器对控制面的最小需求（AgentControlClient 结构满足；测试可注入内存实现）。 */
export interface HtmlRenderControl extends DurableToolControl {
  uploadArtifact(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    role: string;
    stepId: string;
    parentArtifactId?: string;
    mime: string;
    bytes: Uint8Array;
    sha256: string;
    userVisible?: boolean;
    outputName?: string;
  }): Promise<RegisteredAgentArtifact>;
  getArtifactByCall(runId: string, leaseId: string, callId: string, outputName?: string): Promise<RegisteredAgentArtifact>;
  recordUsage(args: {
    runId: string;
    leaseId: string;
    callId: string;
    kind: string;
    provider: string;
    model: string;
    inputUnits?: number;
    outputUnits?: number;
  }): Promise<void>;
  downloadVerifiedBytes(url: string, expected: { sha256: string; bytes: number }, maxBytes?: number): Promise<Uint8Array>;
}

/** 执行器对工作区的最小只读需求（RunWorkspace 结构满足）。 */
export interface HtmlRenderWorkspace {
  readArtifact(artifactId: string): Promise<{ mime: "image/png" | "image/jpeg" | "image/webp"; bytes: Uint8Array; sha256: string }>;
  readHtmlDocumentArtifact(artifactId: string): Promise<string>;
  /** Fresh outputs become readable by a later approved inspection in the same Run/session. */
  rememberRemoteArtifact?(artifact: RegisteredAgentArtifact): void;
}

export type HtmlRenderExecutorConfig = {
  rendererUrl: string;
  internalToken: string;
  fetch?: AgentWorkerFetch;
};

export function htmlRenderConfigFromEnv(env: Record<string, string | undefined>): HtmlRenderExecutorConfig | undefined {
  const url = env.RENDERER_URL?.trim().replace(/\/+$/, "");
  const token = env.RENDER_INTERNAL_TOKEN?.trim();
  if (!url || !token) return undefined;
  return { rendererUrl: url, internalToken: token };
}

export type HtmlRenderDispatchRequest = {
  callId: string;
  phase: string;
  input: RenderHtmlInputV1;
  stepId: string;
};

type VerifiedOutput = {
  role: "viewport_screenshot" | "full_page_screenshot" | "slice_screenshot";
  index?: number;
  outputName: string;
  bytes: Uint8Array;
  sha256: string;
  clipDevicePx: { x: number; y: number; width: number; height: number };
};

type VerifiedRenderOutputs = {
  wire: RendererWireSuccess;
  outputs: VerifiedOutput[];
};

type DurableRenderResult = RenderHtmlResultV1 & { manifestArtifactId: string; manifestObjectKey: string };

const MAX_RENDER_OUTPUTS = 33; // 1 整页 + ≤32 切片（或 1 视口）
const MAX_RENDER_OUTPUT_TOTAL_BYTES = 192 * 1024 * 1024;
const MAX_RESOURCE_TOTAL_BYTES = 20 * 1024 * 1024;
const RETRY_DELAY_MS = 750;

function defaultFetch(): AgentWorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: AgentWorkerFetch }).fetch;
  if (!candidate) throw new Error("html_render_fetch_unavailable");
  return candidate.bind(globalThis);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 最小 PNG 头校验：签名 + IHDR 尺寸。 */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 33) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
  const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  if (width === 0 || height === 0) return null;
  return { width, height };
}

class RendererTransportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "RendererTransportError";
    this.code = code;
  }
}

function isWireSuccess(value: unknown): value is RendererWireSuccess {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

function isWireFailure(value: unknown): value is RendererWireFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string";
}

class RendererServiceClient {
  private readonly config: HtmlRenderExecutorConfig;
  private readonly fetch: AgentWorkerFetch;

  constructor(config: HtmlRenderExecutorConfig) {
    this.config = config;
    this.fetch = config.fetch ?? defaultFetch();
  }

  /** 一次渲染调用；网络/可重试错误抛 RendererTransportError，稳定业务错误抛终态 DurableProviderError。 */
  async renderOnce(request: RendererWireRequest): Promise<RendererWireSuccess> {
    let response: HttpResponse;
    try {
      response = await this.fetch(`${this.config.rendererUrl}/render`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.internalToken}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (error) {
      // kill -9 模拟不得被归一化为网络错误（否则会掩盖崩溃恢复路径）。
      if (error instanceof SimulatedProcessCrash) throw error;
      throw new RendererTransportError("render_service_unavailable");
    }
    if (response.status === 401 || response.status === 413) {
      throw new DurableProviderError("terminal", "render_service_unavailable");
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw new RendererTransportError("render_output_invalid");
    }
    if (response.ok && isWireSuccess(body)) return body;
    if (isWireFailure(body)) {
      const failure = body as RendererWireFailure;
      if (response.status >= 500 || response.status === 429 || failure.retryable) {
        throw new RendererTransportError(failure.code);
      }
      throw new DurableProviderError("terminal", failure.code);
    }
    throw new RendererTransportError("render_service_unavailable");
  }
}

class HtmlRenderAdapter implements DurableToolAdapter<HtmlRenderDispatchRequest, DurableRenderResult> {
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly control: HtmlRenderControl;
  private readonly workspace: HtmlRenderWorkspace;
  private readonly renderer: RendererServiceClient;
  /** execute 成功但尚未 persist 的内存结果（同进程内 persist 崩溃恢复用）。 */
  private readonly computed = new Map<string, VerifiedRenderOutputs>();
  readonly requests = new Map<string, HtmlRenderDispatchRequest>();

  constructor(args: {
    runId: string;
    leaseId: string;
    control: HtmlRenderControl;
    workspace: HtmlRenderWorkspace;
    renderer: RendererServiceClient;
  }) {
    this.runId = args.runId;
    this.leaseId = args.leaseId;
    this.control = args.control;
    this.workspace = args.workspace;
    this.renderer = args.renderer;
  }

  async execute(callId: string, request: HtmlRenderDispatchRequest): Promise<DurableRenderResult> {
    const verified = await this.computeVerified(callId, request);
    return pendingResult(verified);
  }

  private async computeVerified(callId: string, request: HtmlRenderDispatchRequest): Promise<VerifiedRenderOutputs> {
    const input = request.input;
    let html: string;
    try {
      html = await this.workspace.readHtmlDocumentArtifact(input.htmlArtifactId);
    } catch {
      throw new DurableProviderError("terminal", "render_resource_invalid");
    }
    const resources: RendererWireRequest["resources"] = [];
    let totalResourceBytes = 0;
    if (input.resourceArtifactIds.length > 0) {
      const images = await Promise.all(input.resourceArtifactIds.map(async (artifactId) => {
        try {
          return await this.workspace.readArtifact(artifactId);
        } catch {
          throw new DurableProviderError("terminal", "render_resource_invalid");
        }
      }));
      images.forEach((image, index) => {
        // 资源占位 key 与数组顺序一一对应：resourceArtifactIds[i] ⇔ HTML 内 asset:reference-{i+1}。
        resources.push({
          key: `reference-${index + 1}`,
          mime: image.mime,
          sha256: image.sha256,
          dataBase64: base64Encode(image.bytes),
        });
        totalResourceBytes += image.bytes.byteLength;
      });
    }
    if (totalResourceBytes > MAX_RESOURCE_TOTAL_BYTES) throw new DurableProviderError("terminal", "render_resource_invalid");

    const wireRequest: RendererWireRequest = {
      schemaVersion: 1,
      requestId: `${this.runId}.${callId}`,
      runId: this.runId,
      callId,
      argsHash: computeArgsHash(request),
      html,
      resources,
      viewport: input.viewport,
      capture: input.capture,
      background: input.background,
    };

    // 可重试错误单次有界重试（§11：layout_unstable / timeout / capacity_busy / service_unavailable）。
    let lastTransport: RendererTransportError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const wire = await this.renderer.renderOnce(wireRequest);
        const verified = this.verifyWireResult(wire, callId, wireRequest.argsHash);
        this.computed.set(callId, verified);
        return verified;
      } catch (error) {
        if (error instanceof DurableProviderError) throw error;
        if (error instanceof RendererTransportError) {
          // 保留首个可重试错误码（根因诊断），后续重试错误不覆盖。
          lastTransport = lastTransport ?? error;
          if (attempt === 0) await new Promise<void>((resolve) => { setTimeout(() => resolve(), RETRY_DELAY_MS); });
          continue;
        }
        throw error;
      }
    }
    // 仍可重试类：outcome_unknown 停车（不终态失败）；重 claim 后 reconcile 安全重算。
    throw new DurableProviderError("unknown", lastTransport?.code ?? "render_service_unavailable");
  }

  /** renderer 响应复核（§5.4 双向）：回显字段、输出数量/顺序、PNG 签名/尺寸/sha/字节、总量。 */
  private verifyWireResult(wire: RendererWireSuccess, callId: string, argsHash: string): VerifiedRenderOutputs {
    if (wire.schemaVersion !== 1 || wire.runId !== this.runId || wire.callId !== callId || wire.argsHash !== argsHash) {
      throw new DurableProviderError("terminal", "render_output_invalid");
    }
    if (typeof wire.rendererFingerprint !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(wire.rendererFingerprint)) {
      throw new DurableProviderError("terminal", "render_output_invalid");
    }
    const doc = wire.document;
    if (!doc || !Number.isInteger(doc.widthDevicePx) || !Number.isInteger(doc.heightDevicePx) || doc.widthDevicePx <= 0 || doc.heightDevicePx <= 0) {
      throw new DurableProviderError("terminal", "render_output_invalid");
    }
    if (!Array.isArray(wire.outputs) || wire.outputs.length === 0 || wire.outputs.length > MAX_RENDER_OUTPUTS) {
      throw new DurableProviderError("terminal", "render_output_invalid");
    }
    const outputs: VerifiedOutput[] = [];
    const seenNames = new Set<string>();
    let total = 0;
    let sawFull = false;
    let sawViewport = false;
    for (const output of wire.outputs) {
      if (output.mime !== "image/png") throw new DurableProviderError("terminal", "render_output_invalid");
      const bytes = base64Decode(output.dataBase64 ?? "");
      if (bytes.byteLength === 0 || bytes.byteLength !== output.bytes || sha256Hex(bytes) !== output.sha256) {
        throw new DurableProviderError("terminal", "render_output_invalid");
      }
      const dims = pngDimensions(bytes);
      if (!dims || dims.width !== output.widthDevicePx || dims.height !== output.heightDevicePx) {
        throw new DurableProviderError("terminal", "render_output_invalid");
      }
      total += bytes.byteLength;
      if (total > MAX_RENDER_OUTPUT_TOTAL_BYTES) throw new DurableProviderError("terminal", "render_document_too_large");

      let outputName: string;
      if (output.role === "viewport_screenshot") {
        sawViewport = true;
        outputName = "viewport";
      } else if (output.role === "full_page_screenshot") {
        sawFull = true;
        outputName = "full";
      } else if (output.role === "slice_screenshot" && Number.isInteger(output.index) && (output.index ?? 0) >= 1 && (output.index ?? 0) <= 32) {
        outputName = `slice-${String(output.index).padStart(4, "0")}`;
      } else {
        throw new DurableProviderError("terminal", "render_output_invalid");
      }
      if (sawFull && sawViewport) throw new DurableProviderError("terminal", "render_output_invalid");
      if (output.role === "slice_screenshot" && !sawFull) {
        throw new DurableProviderError("terminal", "render_output_invalid"); // 切片必须跟在整页之后
      }
      if (seenNames.has(outputName)) throw new DurableProviderError("terminal", "render_output_invalid");
      seenNames.add(outputName);
      outputs.push({ role: output.role, index: output.index, outputName, bytes, sha256: output.sha256, clipDevicePx: output.clipDevicePx });
    }
    return { wire, outputs };
  }

  /**
   * §6.1：先查 ledger（manifest artifact），命中则下载重建；缺失时以同一 call id 安全重算。
   * （render 是确定性计算且 artifact 内容寻址幂等，重算不产生重复用户资产或重复计费。）
   */
  async reconcile(callId: string, request: HtmlRenderDispatchRequest): Promise<DurableRenderResult | null> {
    const cached = this.computed.get(callId);
    if (cached) return pendingResult(cached);
    const restored = await this.tryRestoreFromManifest(callId);
    if (restored) return restored;
    return pendingResult(await this.computeVerified(callId, request));
  }

  private async tryRestoreFromManifest(callId: string, expectedSha256?: string): Promise<DurableRenderResult | null> {
    try {
      const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, callId, "manifest");
      if (artifact.role !== "render_manifest" || artifact.mime !== "application/json" || !artifact.url) return null;
      if (expectedSha256 && artifact.sha256 !== expectedSha256) throw new Error("html_render_restore_hash_mismatch");
      const bytes = await this.control.downloadVerifiedBytes(artifact.url, artifact);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (typeof parsed !== "object" || parsed === null || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
          !Array.isArray((parsed as { outputs?: unknown }).outputs)) {
        throw new Error("html_render_manifest_invalid");
      }
      return { ...(parsed as RenderHtmlResultV1), manifestArtifactId: artifact.artifactId, manifestObjectKey: artifact.objectKey };
    } catch (error) {
      if (error instanceof AgentControlError && error.status === 409) return null;
      throw error;
    }
  }

  async persist(callId: string, _result: DurableRenderResult) {
    const request = this.requests.get(callId);
    if (!request) throw new Error("html_render_request_missing");
    const verified = this.computed.get(callId);
    if (!verified) throw new Error("html_render_computed_missing");

    // 1) 全部 PNG（顺序：整页 → 视口 → 切片按 index；切片 parent = 整页 artifact）。
    let fullArtifactId: string | undefined;
    const uploaded: RenderHtmlResultV1["outputs"] = [];
    for (const output of verified.outputs) {
      if (output.role === "slice_screenshot" && !fullArtifactId) throw new Error("html_render_full_missing");
      const artifact = await this.control.uploadArtifact({
        runId: this.runId,
        leaseId: this.leaseId,
        sourceCallId: callId,
        role: output.role,
        stepId: request.stepId,
        ...(output.role === "slice_screenshot" && fullArtifactId ? { parentArtifactId: fullArtifactId } : {}),
        mime: "image/png",
        bytes: output.bytes,
        sha256: output.sha256,
        outputName: output.outputName,
      });
      this.workspace.rememberRemoteArtifact?.(artifact);
      if (output.role === "full_page_screenshot") fullArtifactId = artifact.artifactId;
      uploaded.push({
        artifactId: artifact.artifactId,
        role: output.role,
        ...(output.index !== undefined ? { index: output.index } : {}),
        clipDevicePx: output.clipDevicePx,
        mime: "image/png",
        bytes: output.bytes.byteLength,
        sha256: output.sha256,
      });
    }

    // 2) manifest artifact（结构化渲染参数、fingerprint、尺寸、clip 与输出 hash，§4.4）。
    const manifest: RenderHtmlResultV1 = {
      schemaVersion: 1,
      rendererFingerprint: verified.wire.rendererFingerprint,
      sourceHtmlSha256: verified.wire.sourceHtmlSha256,
      argsHash: verified.wire.argsHash,
      document: verified.wire.document,
      renderMs: verified.wire.renderMs,
      outputs: uploaded,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestArtifact = await this.control.uploadArtifact({
      runId: this.runId,
      leaseId: this.leaseId,
      sourceCallId: callId,
      role: "render_manifest",
      stepId: request.stepId,
      mime: "application/json",
      bytes: manifestBytes,
      sha256: sha256Hex(manifestBytes),
      userVisible: false,
      outputName: "manifest",
    });

    // 3) 技术 usage（首版 0 积分；容量保护与未来测算用，§7.3）。
    await this.control.recordUsage({
      runId: this.runId,
      leaseId: this.leaseId,
      callId,
      kind: "html_render",
      provider: "renderer",
      model: verified.wire.rendererFingerprint,
      outputUnits: uploaded.length,
    });

    this.computed.delete(callId);
    this.requests.delete(callId);
    return {
      value: { ...manifest, manifestArtifactId: manifestArtifact.artifactId, manifestObjectKey: manifestArtifact.objectKey },
      resultObjectKey: manifestArtifact.objectKey,
      resultHash: manifestArtifact.sha256,
    };
  }

  async restore(record: PreparedToolCall): Promise<DurableRenderResult> {
    const restored = await this.tryRestoreFromManifest(record.callId, record.resultHash ?? undefined);
    if (!restored) throw new Error("html_render_manifest_missing");
    return restored;
  }
}

function pendingResult(verified: VerifiedRenderOutputs): DurableRenderResult {
  return {
    schemaVersion: 1,
    rendererFingerprint: verified.wire.rendererFingerprint,
    sourceHtmlSha256: verified.wire.sourceHtmlSha256,
    argsHash: verified.wire.argsHash,
    document: verified.wire.document,
    renderMs: verified.wire.renderMs,
    outputs: verified.outputs.map((output) => ({
      artifactId: `pending:${output.outputName}`,
      role: output.role,
      ...(output.index !== undefined ? { index: output.index } : {}),
      clipDevicePx: output.clipDevicePx,
      mime: "image/png" as const,
      bytes: output.bytes.byteLength,
      sha256: output.sha256,
    })),
    manifestArtifactId: "pending:manifest",
    manifestObjectKey: "pending:manifest",
  };
}

export function createHtmlRenderExecutor(args: {
  runId: string;
  leaseId: string;
  control: HtmlRenderControl;
  workspace: HtmlRenderWorkspace;
  config: HtmlRenderExecutorConfig;
  /** 测试钩子：execute 成功后、persist 前介入（模拟 kill -9，走 dispatcher 原生路径）。 */
  options?: { afterExecute?: () => void };
}): { render: (request: HtmlRenderDispatchRequest) => Promise<DurableRenderResult> } {
  const adapter = new HtmlRenderAdapter({
    runId: args.runId,
    leaseId: args.leaseId,
    control: args.control,
    workspace: args.workspace,
    renderer: new RendererServiceClient(args.config),
  });
  const dispatcher = new DurableToolDispatcher(args.control, adapter, { afterExecute: args.options?.afterExecute });
  return {
    render: async (request) => {
      adapter.requests.set(request.callId, request);
      const identity: DurableToolIdentity = {
        runId: args.runId,
        leaseId: args.leaseId,
        callId: request.callId,
        phase: request.phase,
        toolName: "render_html",
      };
      return await dispatcher.dispatch(identity, request);
    },
  };
}
