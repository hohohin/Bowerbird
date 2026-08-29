import { createHash } from "node:crypto";
import type { ControlledRunnerCheckpoint } from "../kernel/controlled-image-edit-runner.ts";
import { decodeControlledCheckpoint, encodeControlledCheckpoint } from "../kernel/controlled-checkpoint.ts";
import type { ClarificationProposal } from "../contracts/clarification.ts";

type JsonRecord = Record<string, unknown>;

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: HttpHeaders;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type AgentWorkerFetch = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

export type ClaimedAgentRun = {
  run: null | {
    id: string;
    conversationId: string;
    skillId: string;
    skillVersion: string;
    inputManifestHash: string;
    approvedPlanHash: string | null;
    plannedToolCount: number | null;
    resultFeedbackAction: "accept" | "retry" | null;
    budgetCredits: number;
    pricingVersion: number;
    checkpointHash: string | null;
    snapshotSchemaVersion: number | null;
    imageProvider?: "cloud" | "jimeng" | "codex";
  };
  lease?: { leaseId: string; leaseSeconds: number };
  inputUrl?: string | null;
  checkpointUrl?: string | null;
  feedbackUrl?: string | null;
  clarificationAnswer?: null | {
    questionKey: string;
    contextHash: string;
    intentPatchHash: string;
    url: string;
  };
  artifactUrls?: ClaimedArtifact[];
};

export type ClaimedArtifact = {
  artifactId: string;
  conversationId: string;
  runId: string;
  role:
    | "input"
    | "control_reference"
    | "stage_result"
    | "final_result"
    | "plan"
    | "diagnostic"
    | "html_document"
    | "render_manifest"
    | "viewport_screenshot"
    | "full_page_screenshot"
    | "slice_screenshot";
  stepId?: string | null;
  parentArtifactId?: string | null;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  userVisible: boolean;
  url?: string | null;
};

export type RegisteredAgentArtifact = ClaimedArtifact & {
  objectKey: string;
};

export type AgentHeartbeat = {
  status: string;
  cancelRequested: boolean;
  leaseExpiresAt: string | null;
};

export type PreparedToolCall = {
  callId: string;
  status: "prepared" | "submitted" | "succeeded" | "failed" | "outcome_unknown";
  providerRequestId?: string | null;
  resultObjectKey?: string | null;
  resultHash?: string | null;
  reused: boolean;
};

export type LocalTaskRecord = {
  callId: string;
  status: "pending" | "completed" | "failed" | "expired";
  resultObjectKey?: string | null;
  resultSha256?: string | null;
  resultMime?: string | null;
  resultBytes?: number | null;
  errorCode?: string | null;
  safeMessage?: string | null;
  expiresAt?: string | null;
};

export type AgentDisplayEvent = {
  seq: number;
  type: string;
  step?: string;
  progress?: number;
  displayPayload?: Record<string, unknown>;
};

export type AgentRuntimeMetrics = {
  measuredAt: string;
  queueDepth: number;
  oldestQueuedAgeSeconds: number;
  activeRuns: number;
  expiredLeases: number;
  last24h: {
    succeeded: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    averageCredits: number | null;
    maxCredits: number | null;
    failuresByCode: Record<string, number>;
    sampleSize: number;
    truncated: boolean;
  };
  testLast24h: {
    succeeded: number;
    failed: number;
    cancelled: number;
    sampleSize: number;
    truncated: boolean;
  };
  ttlBacklog: { runs: number; artifacts: number };
};

export class AgentControlError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`agent_control_http_${status}`);
    this.name = "AgentControlError";
    this.status = status;
  }
}

function defaultFetch(): AgentWorkerFetch {
  const candidate = (globalThis as unknown as { fetch?: AgentWorkerFetch }).fetch;
  if (!candidate) throw new Error("agent_fetch_unavailable");
  return candidate.bind(globalThis);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): JsonRecord {
  try {
    const value = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {
    // Normalize below; never include a private response body in the error.
  }
  throw new Error("agent_control_invalid_json");
}

export class AgentControlClient {
  private readonly controlUrl: string;
  private readonly workerToken: string;
  private readonly workerId: string;
  private readonly fetch: AgentWorkerFetch;

  constructor(config: { controlUrl: string; workerToken: string; workerId: string }, fetchImpl?: AgentWorkerFetch) {
    this.controlUrl = config.controlUrl;
    this.workerToken = config.workerToken;
    this.workerId = config.workerId;
    this.fetch = fetchImpl ?? defaultFetch();
  }

  async post(body: JsonRecord): Promise<JsonRecord> {
    const response = await this.fetch(this.controlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.workerToken}`,
        "content-type": "application/json",
        "x-worker-id": this.workerId,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new AgentControlError(response.status);
    return parseJson(text);
  }

  async claim(): Promise<ClaimedAgentRun> {
    return await this.post({ action: "claim" }) as unknown as ClaimedAgentRun;
  }

  async cleanupExpired(): Promise<{ removedObjects: number; deletedEvents: number; expiredRuns: number; expiredParkedRuns: number }> {
    const result = await this.post({ action: "cleanup_expired" });
    return {
      removedObjects: Number(result.removedObjects ?? 0),
      deletedEvents: Number(result.deletedEvents ?? 0),
      expiredRuns: Number(result.expiredRuns ?? 0),
      expiredParkedRuns: Number(result.expiredParkedRuns ?? 0),
    };
  }

  async metrics(): Promise<AgentRuntimeMetrics> {
    return await this.post({ action: "metrics" }) as unknown as AgentRuntimeMetrics;
  }

  async heartbeat(runId: string, leaseId: string): Promise<AgentHeartbeat> {
    return await this.post({ action: "heartbeat", runId, leaseId }) as unknown as AgentHeartbeat;
  }

  async download(url: string): Promise<Uint8Array> {
    const response = await this.fetch(url, { method: "GET" });
    if (!response.ok) throw new Error(`agent_object_download_http_${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async downloadVerifiedJson(url: string, expectedSha256: string, maxBytes = 20 * 1024 * 1024): Promise<unknown> {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("agent_object_expected_hash_invalid");
    const bytes = await this.download(url);
    if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error("agent_object_size_invalid");
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new Error("agent_object_hash_mismatch");
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("agent_object_json_invalid");
    }
  }

  async downloadVerifiedBytes(url: string, expected: { sha256: string; bytes: number }, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || expected.bytes > maxBytes) {
      throw new Error("agent_object_expected_metadata_invalid");
    }
    const bytes = await this.download(url);
    if (bytes.byteLength !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error("agent_object_hash_mismatch");
    }
    return bytes;
  }

  async loadControlledCheckpoint(
    claimed: ClaimedAgentRun & { run: NonNullable<ClaimedAgentRun["run"]> },
    expectedSkillHash: string,
  ): Promise<ControlledRunnerCheckpoint | null> {
    if (!claimed.run.checkpointHash && !claimed.checkpointUrl) return null;
    if (!claimed.run.checkpointHash || !claimed.checkpointUrl || claimed.run.snapshotSchemaVersion !== 1) {
      throw new Error("agent_checkpoint_claim_incomplete");
    }
    const bytes = await this.download(claimed.checkpointUrl);
    return decodeControlledCheckpoint(bytes, {
      runId: claimed.run.id,
      conversationId: claimed.run.conversationId,
      skillVersion: claimed.run.skillVersion,
      skillHash: expectedSkillHash,
      sha256: claimed.run.checkpointHash,
    });
  }

  async saveCheckpoint(args: {
    runId: string;
    leaseId: string;
    checkpoint: ControlledRunnerCheckpoint;
    step: string;
    progress: number;
  }): Promise<{ checkpointHash: string; objectKey: string }> {
    const encoded = encodeControlledCheckpoint(args.checkpoint);
    return await this.saveRawCheckpoint({
      runId: args.runId,
      leaseId: args.leaseId,
      bytes: encoded.bytes,
      sha256: encoded.sha256,
      snapshotSchemaVersion: args.checkpoint.schemaVersion,
      step: args.step,
      progress: args.progress,
    });
  }

  /** Skill 无关的 checkpoint 落盘（两阶段 prepare/upload/commit；HTML 等新 Skill 复用）。 */
  async saveRawCheckpoint(args: {
    runId: string;
    leaseId: string;
    bytes: Uint8Array;
    sha256: string;
    snapshotSchemaVersion: number;
    step: string;
    progress: number;
  }): Promise<{ checkpointHash: string; objectKey: string }> {
    const prepared = await this.post({
      action: "checkpoint_prepare",
      runId: args.runId,
      leaseId: args.leaseId,
      checkpointHash: args.sha256,
      snapshotSchemaVersion: args.snapshotSchemaVersion,
    });
    if (typeof prepared.uploadUrl !== "string" || typeof prepared.objectKey !== "string") {
      throw new Error("agent_checkpoint_prepare_invalid");
    }
    const uploaded = await this.fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-upsert": "true" },
      body: args.bytes,
    });
    if (!uploaded.ok) throw new Error(`agent_checkpoint_upload_http_${uploaded.status}`);
    await this.post({
      action: "checkpoint_commit",
      runId: args.runId,
      leaseId: args.leaseId,
      checkpointHash: args.sha256,
      snapshotSchemaVersion: args.snapshotSchemaVersion,
      step: args.step,
      progress: args.progress,
    });
    return { checkpointHash: args.sha256, objectKey: prepared.objectKey };
  }

  /** Skill 无关的 checkpoint 读取（hash 由调用方 codec 复核）。 */
  async loadRawCheckpoint(
    claimed: ClaimedAgentRun & { run: NonNullable<ClaimedAgentRun["run"]> },
  ): Promise<Uint8Array | null> {
    if (!claimed.run.checkpointHash && !claimed.checkpointUrl) return null;
    if (!claimed.run.checkpointHash || !claimed.checkpointUrl || claimed.run.snapshotSchemaVersion === null) {
      throw new Error("agent_checkpoint_claim_incomplete");
    }
    return await this.download(claimed.checkpointUrl);
  }

  async appendEvents(runId: string, leaseId: string, events: AgentDisplayEvent[]): Promise<void> {
    if (!events.length) return;
    await this.post({ action: "events", runId, leaseId, events });
  }

  async prepareTool(args: {
    runId: string; leaseId: string; callId: string; phase: string; toolName: string; argsHash: string;
  }): Promise<PreparedToolCall> {
    return await this.post({ action: "tool_prepare", ...args }) as unknown as PreparedToolCall;
  }

  async markToolSubmitted(args: {
    runId: string; leaseId: string; callId: string; providerRequestId?: string;
  }): Promise<PreparedToolCall> {
    return await this.post({ action: "tool_submitted", ...args }) as unknown as PreparedToolCall;
  }

  async completeTool(args: {
    runId: string; leaseId: string; callId: string;
    status: "succeeded" | "failed" | "outcome_unknown";
    resultObjectKey?: string; resultHash?: string; safeErrorCode?: string;
  }): Promise<PreparedToolCall> {
    return await this.post({ action: "tool_complete", ...args }) as unknown as PreparedToolCall;
  }

  async uploadArtifact(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    role:
      | "control_reference"
      | "stage_result"
      | "final_result"
      | "diagnostic"
      | "html_document"
      | "render_manifest"
      | "viewport_screenshot"
      | "full_page_screenshot"
      | "slice_screenshot";
    stepId: string;
    parentArtifactId?: string;
    mime: "image/png" | "image/jpeg" | "image/webp" | "text/html" | "application/json";
    bytes: Uint8Array;
    sha256: string;
    userVisible?: boolean;
    /** 同一 call 的多输出判别子（如 "manifest" / "full" / "slice-0001"）；空 = 单输出 legacy 形态。 */
    outputName?: string;
  }): Promise<RegisteredAgentArtifact> {
    const metadata = {
      runId: args.runId,
      leaseId: args.leaseId,
      sourceCallId: args.sourceCallId,
      role: args.role,
      stepId: args.stepId,
      parentArtifactId: args.parentArtifactId,
      mime: args.mime,
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: args.userVisible ?? true,
      ...(args.outputName ? { outputName: args.outputName } : {}),
    };
    const prepared = await this.post({ action: "artifact_prepare", ...metadata });
    if (typeof prepared.uploadUrl !== "string" || typeof prepared.objectKey !== "string") {
      throw new Error("agent_artifact_prepare_invalid");
    }
    const uploaded = await this.fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: { "content-type": args.mime, "x-upsert": "true" },
      body: args.bytes,
    });
    if (!uploaded.ok) throw new Error(`agent_artifact_upload_http_${uploaded.status}`);
    return await this.post({ action: "artifact", ...metadata }) as unknown as RegisteredAgentArtifact;
  }

  async uploadDiagnostic(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    stepId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<RegisteredAgentArtifact> {
    if (!args.bytes.byteLength || args.bytes.byteLength > 64 * 1024) throw new Error("agent_diagnostic_size_invalid");
    const metadata = {
      runId: args.runId,
      leaseId: args.leaseId,
      sourceCallId: args.sourceCallId,
      role: "diagnostic",
      stepId: args.stepId,
      mime: "application/json",
      bytes: args.bytes.byteLength,
      sha256: args.sha256,
      userVisible: false,
    };
    const prepared = await this.post({ action: "artifact_prepare", ...metadata });
    if (typeof prepared.uploadUrl !== "string" || typeof prepared.objectKey !== "string") {
      throw new Error("agent_diagnostic_prepare_invalid");
    }
    const uploaded = await this.fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-upsert": "true" },
      body: args.bytes,
    });
    if (!uploaded.ok) throw new Error(`agent_diagnostic_upload_http_${uploaded.status}`);
    return await this.post({ action: "artifact", ...metadata }) as unknown as RegisteredAgentArtifact;
  }

  async getArtifactByCall(runId: string, leaseId: string, callId: string, outputName?: string): Promise<RegisteredAgentArtifact> {
    return await this.post({
      action: "artifact_get",
      runId,
      leaseId,
      callId,
      ...(outputName ? { outputName } : {}),
    }) as unknown as RegisteredAgentArtifact;
  }

  async requestLocalTask(args: {
    runId: string;
    leaseId: string;
    callId: string;
    provider: "jimeng" | "codex";
    stepId: string;
    params: {
      prompt: string;
      ratio?: string | null;
      inputs: Array<{ artifactId: string; role: string; stepId: string | null }>;
    };
  }): Promise<LocalTaskRecord> {
    return await this.post({
      action: "local_task_request",
      runId: args.runId,
      leaseId: args.leaseId,
      callId: args.callId,
      provider: args.provider,
      stepId: args.stepId,
      expiresInSeconds: 1800,
      params: {
        prompt: args.params.prompt,
        ratio: args.params.ratio ?? null,
        inputs: args.params.inputs,
      },
    }) as unknown as LocalTaskRecord;
  }

  async getLocalTaskStatus(runId: string, leaseId: string, callId: string): Promise<LocalTaskRecord> {
    return await this.post({ action: "local_task_status", runId, leaseId, callId }) as unknown as LocalTaskRecord;
  }

  async awaitLocalTask(runId: string, leaseId: string, callId: string): Promise<{ parked: boolean; status: string }> {
    const result = await this.post({ action: "local_task_await", runId, leaseId, callId });
    return {
      parked: result.parked === true,
      status: typeof result.status === "string" ? result.status : "unknown",
    };
  }

  /** 桌面已直传到确定性 artifact key 的本地生图结果：只走 commit 校验登记，不再 PUT。 */
  async registerLocalArtifact(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    role: "control_reference" | "stage_result" | "final_result";
    stepId: string;
    parentArtifactId?: string;
    mime: "image/png" | "image/jpeg" | "image/webp";
    bytes: number;
    sha256: string;
  }): Promise<RegisteredAgentArtifact> {
    return await this.post({
      action: "artifact",
      runId: args.runId,
      leaseId: args.leaseId,
      sourceCallId: args.sourceCallId,
      role: args.role,
      stepId: args.stepId,
      parentArtifactId: args.parentArtifactId,
      mime: args.mime,
      bytes: args.bytes,
      sha256: args.sha256,
      userVisible: true,
    }) as unknown as RegisteredAgentArtifact;
  }

  async recordUsage(args: {
    runId: string;
    leaseId: string;
    callId: string;
    kind: "model_tokens" | "vision_call" | "image_generation" | "html_render";
    provider: "deepseek" | "ark" | "jimeng" | "codex" | "renderer";
    model: string;
    inputUnits?: number;
    outputUnits?: number;
    imageCount?: number;
    resolution?: string;
  }): Promise<void> {
    await this.post({
      action: "usage",
      runId: args.runId,
      leaseId: args.leaseId,
      items: [{
        callId: args.callId,
        kind: args.kind,
        provider: args.provider,
        model: args.model,
        inputUnits: args.inputUnits ?? 0,
        outputUnits: args.outputUnits ?? 0,
        imageCount: args.imageCount ?? 0,
        resolution: args.resolution,
      }],
    });
  }

  async requestApproval(args: {
    runId: string;
    leaseId: string;
    kind: "controlled_image_edit_plan" | "controlled_image_edit_revision";
    proposalHash: string;
    proposal: Record<string, unknown>;
    plannedToolCount: number;
    estimatedAdditionalCredits: number;
  }): Promise<void> {
    await this.post({ action: "approval_request", ...args });
  }

  async requestUnifiedPlanApproval(args: {
    runId: string;
    leaseId: string;
    callId: string;
    argsHash: string;
    proposalHash: string;
    proposal: Record<string, unknown>;
  }): Promise<{
    status: "awaiting_approval";
    proposalHash: string;
    estimatedAdditionalCredits: number;
    reused: boolean;
  }> {
    const result = await this.post({
      action: "approval_request",
      kind: "unified_agent_plan",
      ...args,
    });
    if (result.status !== "awaiting_approval" || result.proposalHash !== args.proposalHash ||
        !Number.isSafeInteger(result.estimatedAdditionalCredits) || Number(result.estimatedAdditionalCredits) < 0 ||
        typeof result.reused !== "boolean") {
      throw new Error("agent_unified_plan_approval_response_invalid");
    }
    return {
      status: "awaiting_approval",
      proposalHash: args.proposalHash,
      estimatedAdditionalCredits: Number(result.estimatedAdditionalCredits),
      reused: result.reused,
    };
  }

  async requestClarification(args: {
    runId: string;
    leaseId: string;
    proposal: ClarificationProposal;
    proposalHash: string;
  }): Promise<void> {
    await this.post({ action: "clarification_request", ...args });
  }

  async awaitResultFeedback(runId: string, leaseId: string): Promise<void> {
    await this.post({ action: "await_result_feedback", runId, leaseId });
  }

  async finish(runId: string, leaseId: string): Promise<void> {
    await this.post({ action: "finish", runId, leaseId });
  }

  async cancel(runId: string, leaseId: string): Promise<void> {
    await this.post({ action: "cancel", runId, leaseId });
  }

  async fail(runId: string, leaseId: string, safeErrorCode: string, safeMessage: string): Promise<void> {
    await this.post({ action: "fail", runId, leaseId, safeErrorCode, safeMessage });
  }
}
