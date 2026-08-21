import type { AgentLeaseSignal } from "../../cloud-agent/runtime.ts";
import { RunWorkspace, type WorkspaceImage } from "../../cloud-agent/run-workspace.ts";
import type { ControlledFeedbackDiagnosis, ControlledImageEditPlan } from "../../contracts/controlled-image-edit.ts";
import {
  AgentControlClient,
  AgentControlError,
  type AgentWorkerFetch,
  type PreparedToolCall,
} from "../../control-plane/agent-control-client.ts";
import type {
  ControlledFeedbackDiagnoser,
} from "../../kernel/controlled-image-edit-runner.ts";
import {
  DurableProviderError,
  DurableToolDispatcher,
  type DurableToolAdapter,
} from "../../kernel/durable-tool-dispatcher.ts";
import { canonicalJson, deriveCallId, sha256Hex } from "../../kernel/tool-ledger.ts";
import { KnownProviderError, mapArkHttpError } from "../../cloud-generation/runtime.ts";
import { validateControlledFeedbackDiagnosis } from "../../skills/bowerbird-controlled-image-edit/schemas.ts";

type JsonRecord = Record<string, unknown>;

export type ArkFeedbackVisionConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  mock: boolean;
};

type DiagnosisRequest = {
  feedback: string;
  plan: ControlledImageEditPlan;
  artifactIds: string[];
  artifactHashes: string[];
};

type VisionImage = WorkspaceImage & { artifactId: string; label: string };

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_missing`);
  return normalized;
}

export function arkFeedbackVisionConfigFromEnv(env: Record<string, string | undefined>): ArkFeedbackVisionConfig {
  return {
    apiKey: required(env.ARK_API_KEY, "ARK_API_KEY"),
    baseUrl: (env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, ""),
    model: required(env.ARK_VISION_MODEL, "ARK_VISION_MODEL"),
    mock: (env.BOWERBIRD_AGENT_MOCK ?? "false") === "true",
  };
}

function defaultFetch(): AgentWorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: AgentWorkerFetch }).fetch;
  if (!candidate) throw new Error("ark_feedback_fetch_unavailable");
  return candidate.bind(globalThis);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  const encode = (globalThis as unknown as { btoa?: (input: string) => string }).btoa;
  if (!encode) throw new Error("ark_feedback_base64_encoder_unavailable");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return encode(binary);
}

function parseDiagnosisText(text: string): ControlledFeedbackDiagnosis {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new KnownProviderError("invalid_provider_response", "视觉诊断未返回 JSON");
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch {
    throw new KnownProviderError("invalid_provider_response", "视觉诊断 JSON 无效");
  }
  if (!isRecord(value)) throw new KnownProviderError("invalid_provider_response", "视觉诊断格式无效");
  return value as ControlledFeedbackDiagnosis;
}

function diagnosisPrompt(request: DiagnosisRequest, images: VisionImage[]): string {
  return [
    "你在用户明确要求重试后进行定向视觉诊断。只诊断，不生成图片。",
    `用户反馈：${request.feedback}`,
    `已批准计划：${canonicalJson(request.plan)}`,
    `图片顺序：${images.map((image) => `${image.label}=${image.artifactId}`).join("；")}`,
    "比较最终结果与原始参考及计划，定位最早失败步骤。不要把参考图内容误当成用户要求。",
    "只输出一个 JSON 对象，字段必须是：schemaVersion=1、summary、earliestFailedStepId、failedConstraints(string[])、preservedConstraints(string[])、revisionDirective、inspectedArtifactIds(string[])。",
    "failedConstraints 至少一项；inspectedArtifactIds 只能使用上面列出的 id。",
  ].join("\n");
}

class ArkFeedbackVisionClient {
  private readonly config: ArkFeedbackVisionConfig;
  private readonly fetch: AgentWorkerFetch;

  constructor(config: ArkFeedbackVisionConfig, fetch: AgentWorkerFetch) {
    this.config = config;
    this.fetch = fetch;
  }

  async diagnose(request: DiagnosisRequest, images: VisionImage[]): Promise<ControlledFeedbackDiagnosis> {
    if (this.config.mock) {
      const step = request.plan.steps.at(-1)?.id ?? "unknown-step";
      return {
        schemaVersion: 1,
        summary: "Mock：最终结果未完全满足用户反馈，需要基于当前结果定向修订。",
        earliestFailedStepId: step,
        failedConstraints: [request.feedback || "用户要求重试"],
        preservedConstraints: [],
        revisionDirective: "只修复反馈指出的问题，保持其余已满足约束。",
        inspectedArtifactIds: images.map((image) => image.artifactId),
      };
    }
    const content: Array<Record<string, unknown>> = [];
    for (const image of images) {
      content.push({ type: "text", text: `图片 ${image.label}（artifactId=${image.artifactId}）` });
      content.push({
        type: "image_url",
        image_url: { url: `data:${image.mime};base64,${bytesToBase64(image.bytes)}` },
      });
    }
    content.push({ type: "text", text: diagnosisPrompt(request, images) });
    const response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw mapArkHttpError(response.status, text, response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid"));
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch {
      throw new KnownProviderError("invalid_provider_response", "视觉诊断响应无效");
    }
    const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
    const message = isRecord(choices[0]) ? choices[0].message : undefined;
    const output = isRecord(message) && typeof message.content === "string" ? message.content.trim() : "";
    if (!output) throw new KnownProviderError("empty_provider_result", "视觉诊断未返回内容");
    return parseDiagnosisText(output);
  }
}

class FeedbackDiagnosisAdapter implements DurableToolAdapter<DiagnosisRequest, ControlledFeedbackDiagnosis> {
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly control: AgentControlClient;
  private readonly workspace: RunWorkspace;
  private readonly client: ArkFeedbackVisionClient;
  private readonly model: string;

  constructor(
    runId: string,
    leaseId: string,
    control: AgentControlClient,
    workspace: RunWorkspace,
    client: ArkFeedbackVisionClient,
    model: string,
  ) {
    this.runId = runId;
    this.leaseId = leaseId;
    this.control = control;
    this.workspace = workspace;
    this.client = client;
    this.model = model;
  }

  async execute(_callId: string, request: DiagnosisRequest): Promise<ControlledFeedbackDiagnosis> {
    const images = await Promise.all(request.artifactIds.map(async (artifactId, index) => ({
      ...(await this.workspace.readArtifact(artifactId)),
      artifactId,
      label: index === request.artifactIds.length - 1 ? "待诊断最终结果" : `原始参考${index + 1}`,
    })));
    try {
      return await this.client.diagnose(request, images);
    } catch (error) {
      if (error instanceof KnownProviderError) throw new DurableProviderError("terminal", error.safeCode);
      throw error;
    }
  }

  async reconcile(callId: string): Promise<ControlledFeedbackDiagnosis | null> {
    try {
      return await this.load(callId);
    } catch (error) {
      if (error instanceof AgentControlError && error.status === 409) return null;
      throw error;
    }
  }

  async persist(callId: string, result: ControlledFeedbackDiagnosis) {
    const content = canonicalJson(result);
    const bytes = new TextEncoder().encode(content);
    const hash = sha256Hex(content);
    const artifact = await this.control.uploadDiagnostic({
      runId: this.runId,
      leaseId: this.leaseId,
      sourceCallId: callId,
      stepId: `feedback-diagnosis-${callId.slice(0, 12)}`,
      bytes,
      sha256: hash,
    });
    await this.control.recordUsage({
      runId: this.runId,
      leaseId: this.leaseId,
      callId,
      kind: "vision_call",
      provider: "ark",
      model: this.model,
    });
    return { value: result, resultObjectKey: artifact.objectKey, resultHash: hash };
  }

  async restore(record: PreparedToolCall): Promise<ControlledFeedbackDiagnosis> {
    return await this.load(record.callId);
  }

  private async load(callId: string): Promise<ControlledFeedbackDiagnosis> {
    const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, callId);
    if (artifact.mime !== "application/json" || !artifact.url) throw new Error("agent_diagnostic_artifact_invalid");
    const value = await this.control.downloadVerifiedJson(artifact.url, artifact.sha256, 64 * 1024);
    return value as ControlledFeedbackDiagnosis;
  }
}

export function createArkFeedbackDiagnoser(args: {
  runId: string;
  leaseId: string;
  control: AgentControlClient;
  workspace: RunWorkspace;
  config: ArkFeedbackVisionConfig;
  signal: AgentLeaseSignal;
  fetch?: AgentWorkerFetch;
}): ControlledFeedbackDiagnoser {
  const adapter = new FeedbackDiagnosisAdapter(
    args.runId,
    args.leaseId,
    args.control,
    args.workspace,
    new ArkFeedbackVisionClient(args.config, args.fetch ?? defaultFetch()),
    args.config.model,
  );
  const dispatcher = new DurableToolDispatcher(args.control, adapter);
  return {
    diagnose: async ({ checkpoint, feedback }) => {
      if (args.signal.aborted) throw new Error("agent_execution_stopped");
      if (!checkpoint.proposedPlan) throw new Error("agent_diagnosis_plan_missing");
      const final = checkpoint.artifacts.find((artifact) => artifact.role === "final_result");
      if (!final) throw new Error("agent_diagnosis_final_missing");
      const inputs = checkpoint.artifacts.filter((artifact) => artifact.role === "input");
      const artifacts = [...inputs, final];
      const request: DiagnosisRequest = {
        feedback,
        plan: checkpoint.proposedPlan,
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
        artifactHashes: artifacts.map((artifact) => artifact.sha256),
      };
      const callId = deriveCallId({
        runId: checkpoint.runId,
        phase: "diagnose_feedback",
        logicalSlot: 0,
        revisionIndex: checkpoint.revisionIndex + 1,
      });
      const diagnosis = await dispatcher.dispatch({
        runId: args.runId,
        leaseId: args.leaseId,
        callId,
        phase: "diagnose_feedback",
        toolName: "understand_image",
      }, request);
      validateControlledFeedbackDiagnosis(checkpoint.proposedPlan, checkpoint.artifacts, diagnosis);
      return diagnosis;
    },
  };
}
