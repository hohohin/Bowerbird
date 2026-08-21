import type { AgentLeaseSignal } from "../../cloud-agent/runtime.ts";
import { RunWorkspace, type WorkspaceImage } from "../../cloud-agent/run-workspace.ts";
import {
  AgentControlClient,
  AgentControlError,
  type AgentWorkerFetch,
  type PreparedToolCall,
} from "../../control-plane/agent-control-client.ts";
import type {
  ApprovedStepExecutor,
  GenerateApprovedStepRequest,
  GeneratedApprovedStep,
} from "../../kernel/controlled-image-edit-runner.ts";
import {
  DurableProviderError,
  DurableToolDispatcher,
  type DurableToolAdapter,
} from "../../kernel/durable-tool-dispatcher.ts";
import { KnownProviderError, mapArkHttpError } from "../../cloud-generation/runtime.ts";

type JsonRecord = Record<string, unknown>;

export type ArkControlledImageConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  size: string;
  mock: boolean;
};

type DurableGeneratedStep = GeneratedApprovedStep & {
  image?: WorkspaceImage;
  objectKey?: string;
};

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_missing`);
  return normalized;
}

export function arkControlledImageConfigFromEnv(env: Record<string, string | undefined>): ArkControlledImageConfig {
  return {
    apiKey: required(env.ARK_API_KEY, "ARK_API_KEY"),
    baseUrl: (env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
    model: required(env.ARK_IMAGE_MODEL, "ARK_IMAGE_MODEL"),
    size: env.ARK_IMAGE_SIZE?.trim() || "2K",
    mock: (env.BOWERBIRD_AGENT_MOCK ?? "false") === "true",
  };
}

function defaultFetch(): AgentWorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: AgentWorkerFetch }).fetch;
  if (!candidate) throw new Error("ark_fetch_unavailable");
  return candidate.bind(globalThis);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ToBytes(value: string): Uint8Array {
  const decode = (globalThis as unknown as { atob?: (input: string) => string }).atob;
  if (!decode) throw new KnownProviderError("invalid_provider_response", "方舟图片解码失败");
  const binary = decode(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  const encode = (globalThis as unknown as { btoa?: (input: string) => string }).btoa;
  if (!encode) throw new Error("ark_base64_encoder_unavailable");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return encode(binary);
}

class ArkControlledImageClient {
  private readonly config: ArkControlledImageConfig;
  private readonly fetch: AgentWorkerFetch;

  constructor(config: ArkControlledImageConfig, fetchImpl?: AgentWorkerFetch) {
    this.config = config;
    this.fetch = fetchImpl ?? defaultFetch();
  }

  async generate(prompt: string, references: WorkspaceImage[], ratio?: string): Promise<Uint8Array> {
    if (this.config.mock) return base64ToBytes(ONE_PIXEL_PNG);
    const response = await this.fetch(`${this.config.baseUrl}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        prompt,
        ...(references.length ? {
          image: references.map((reference) => `data:${reference.mime};base64,${bytesToBase64(reference.bytes)}`),
        } : {}),
        size: arkSizeForRatio(ratio) ?? this.config.size,
        response_format: "b64_json",
        watermark: false,
      }),
      // Deliberately no timeout: the Run lease heartbeat owns liveness while Ark waits.
    });
    const text = await response.text();
    if (!response.ok) {
      throw mapArkHttpError(response.status, text, response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid"));
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new KnownProviderError("invalid_provider_response", "方舟返回的图片格式无效"); }
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    const first = data.find(isRecord);
    if (!first) throw new KnownProviderError("empty_provider_result", "Seedream 未返回图片");
    if (typeof first.b64_json === "string" && first.b64_json) return base64ToBytes(first.b64_json);
    if (typeof first.url === "string" && first.url.startsWith("https://")) {
      const downloaded = await this.fetch(first.url, { method: "GET" });
      if (!downloaded.ok) throw new KnownProviderError("provider_result_download_failed", "方舟已返回结果，但图片下载失败");
      return new Uint8Array(await downloaded.arrayBuffer());
    }
    throw new KnownProviderError("invalid_provider_response", "方舟返回的图片格式无效");
  }
}

export function arkSizeForRatio(ratio?: string): string | undefined {
  const sizes: Record<string, string> = {
    "1:1": "2048x2048",
    "3:4": "1728x2304",
    "4:3": "2304x1728",
    "2:3": "1664x2496",
    "3:2": "2496x1664",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
  };
  return ratio ? sizes[ratio] : undefined;
}

class ArkControlledImageAdapter implements DurableToolAdapter<GenerateApprovedStepRequest, DurableGeneratedStep> {
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly control: AgentControlClient;
  private readonly workspace: RunWorkspace;
  private readonly ark: ArkControlledImageClient;
  private readonly model: string;

  constructor(args: {
    runId: string;
    leaseId: string;
    control: AgentControlClient;
    workspace: RunWorkspace;
    ark: ArkControlledImageClient;
    model: string;
  }) {
    this.runId = args.runId;
    this.leaseId = args.leaseId;
    this.control = args.control;
    this.workspace = args.workspace;
    this.ark = args.ark;
    this.model = args.model;
  }

  async execute(callId: string, request: GenerateApprovedStepRequest): Promise<DurableGeneratedStep> {
    const references = await Promise.all(request.inputArtifactIds.map(async (id) => await this.workspace.readArtifact(id)));
    let generated: Uint8Array;
    try {
      const prompt = request.ratio
        ? `${request.prompt}\n输出画面比例：${request.ratio}，必须严格保持该宽高比。`
        : request.prompt;
      generated = await this.ark.generate(prompt, references, request.ratio);
    } catch (error) {
      if (error instanceof KnownProviderError) throw new DurableProviderError("terminal", error.safeCode);
      throw error;
    }
    const image = this.workspace.writeProviderResult(callId, generated);
    return { artifactId: `pending:${callId}`, mime: image.mime, bytes: image.bytes.byteLength, sha256: image.sha256, image };
  }

  async reconcile(callId: string, _request: GenerateApprovedStepRequest): Promise<DurableGeneratedStep | null> {
    try {
      const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, callId);
      this.workspace.rememberRemoteArtifact(artifact);
      return {
        artifactId: artifact.artifactId,
        mime: artifact.mime,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        objectKey: artifact.objectKey,
      };
    } catch (error) {
      if (!(error instanceof AgentControlError) || error.status !== 409) throw error;
    }
    const image = this.workspace.providerResult(callId);
    return image
      ? { artifactId: `pending:${callId}`, mime: image.mime, bytes: image.bytes.byteLength, sha256: image.sha256, image }
      : null;
  }

  async persist(callId: string, result: DurableGeneratedStep) {
    let value = result;
    let objectKey = result.objectKey;
    if (result.artifactId.startsWith("pending:")) {
      const image = result.image ?? this.workspace.providerResult(callId);
      if (!image) throw new Error("agent_provider_result_missing");
      const request = this.requests.get(callId);
      if (!request) throw new Error("agent_provider_request_missing");
      const artifact = await this.control.uploadArtifact({
        runId: this.runId,
        leaseId: this.leaseId,
        sourceCallId: callId,
        role: request.outputRole,
        stepId: request.stepId,
        parentArtifactId: request.parentArtifactId,
        mime: image.mime,
        bytes: image.bytes,
        sha256: image.sha256,
      });
      this.workspace.rememberArtifact(callId, artifact, image);
      objectKey = artifact.objectKey;
      value = { artifactId: artifact.artifactId, mime: artifact.mime, bytes: artifact.bytes, sha256: artifact.sha256, objectKey };
    }
    if (!objectKey) throw new Error("agent_artifact_object_key_missing");
    await this.control.recordUsage({
      runId: this.runId,
      leaseId: this.leaseId,
      callId,
      kind: "image_generation",
      provider: "ark",
      model: this.model,
      imageCount: 1,
    });
    return { value, resultObjectKey: objectKey, resultHash: value.sha256 };
  }

  async restore(record: PreparedToolCall): Promise<DurableGeneratedStep> {
    const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, record.callId);
    if (record.resultHash && artifact.sha256 !== record.resultHash) throw new Error("agent_artifact_restore_hash_mismatch");
    this.workspace.rememberRemoteArtifact(artifact);
    return {
      artifactId: artifact.artifactId,
      mime: artifact.mime,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      objectKey: artifact.objectKey,
    };
  }

  readonly requests = new Map<string, GenerateApprovedStepRequest>();
}

export function createArkApprovedStepExecutor(args: {
  runId: string;
  leaseId: string;
  control: AgentControlClient;
  workspace: RunWorkspace;
  config: ArkControlledImageConfig;
  signal: AgentLeaseSignal;
  fetch?: AgentWorkerFetch;
}): ApprovedStepExecutor {
  const adapter = new ArkControlledImageAdapter({
    runId: args.runId,
    leaseId: args.leaseId,
    control: args.control,
    workspace: args.workspace,
    ark: new ArkControlledImageClient(args.config, args.fetch),
    model: args.config.model,
  });
  const dispatcher = new DurableToolDispatcher(args.control, adapter);
  return {
    generate: async (request) => {
      if (args.signal.aborted) throw new Error("agent_execution_stopped");
      adapter.requests.set(request.callId, request);
      return await dispatcher.dispatch({
        runId: args.runId,
        leaseId: args.leaseId,
        callId: request.callId,
        phase: "execute_approved_plan",
        toolName: "generate_image",
      }, request);
    },
  };
}
