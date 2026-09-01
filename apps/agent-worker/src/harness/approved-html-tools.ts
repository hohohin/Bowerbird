import { createHash } from "node:crypto";

import {
  AgentControlError,
  type PreparedToolCall,
  type RegisteredAgentArtifact,
} from "../control-plane/agent-control-client.ts";
import type { RenderHtmlInputV1 } from "../contracts/render-html.ts";
import {
  DurableToolDispatcher,
  type DurableToolAdapter,
  type DurableToolControl,
  type DurableToolIdentity,
} from "../kernel/durable-tool-dispatcher.ts";
import type { HarnessPlanStep } from "./run-control-tools.ts";
import type { ToolGatewayDefinition } from "./scoped-tool-gateway.ts";
import {
  validateComposeHtmlDocumentAction,
  type ComposeHtmlDocumentActionV1,
} from "../skills/bowerbird-html-layout-render/schemas.ts";

export type ApprovedHtmlDocument = {
  artifactId: string;
  mime: "text/html";
  bytes: number;
  sha256: string;
};

export interface ApprovedHtmlControl extends DurableToolControl {
  uploadArtifact(args: {
    runId: string;
    leaseId: string;
    sourceCallId: string;
    role: string;
    stepId: string;
    mime: string;
    bytes: Uint8Array;
    sha256: string;
    userVisible?: boolean;
  }): Promise<RegisteredAgentArtifact>;
  getArtifactByCall(runId: string, leaseId: string, callId: string): Promise<RegisteredAgentArtifact>;
}

export interface ApprovedHtmlWorkspace {
  rememberHtmlDocument(artifact: RegisteredAgentArtifact, html: string): void;
  rememberRemoteArtifact(artifact: RegisteredAgentArtifact): void;
}

type ComposeResult = { html: string; artifact?: RegisteredAgentArtifact };

class ApprovedComposeHtmlAdapter implements DurableToolAdapter<ComposeHtmlDocumentActionV1, ComposeResult> {
  private readonly args: {
    runId: string;
    leaseId: string;
    stepId: string;
    control: ApprovedHtmlControl;
  };

  constructor(args: { runId: string; leaseId: string; stepId: string; control: ApprovedHtmlControl }) {
    this.args = args;
  }

  async execute(_callId: string, request: ComposeHtmlDocumentActionV1): Promise<ComposeResult> {
    return { html: request.html };
  }

  async reconcile(callId: string): Promise<ComposeResult | null> {
    try {
      return { html: "", artifact: await this.args.control.getArtifactByCall(this.args.runId, this.args.leaseId, callId) };
    } catch (error) {
      if (error instanceof AgentControlError && error.status === 409) return null;
      throw error;
    }
  }

  async persist(callId: string, result: ComposeResult) {
    if (result.artifact) {
      return { value: result, resultObjectKey: result.artifact.objectKey, resultHash: result.artifact.sha256 };
    }
    const bytes = new TextEncoder().encode(result.html);
    const artifact = await this.args.control.uploadArtifact({
      runId: this.args.runId,
      leaseId: this.args.leaseId,
      sourceCallId: callId,
      role: "html_document",
      stepId: this.args.stepId,
      mime: "text/html",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      userVisible: false,
    });
    return { value: { ...result, artifact }, resultObjectKey: artifact.objectKey, resultHash: artifact.sha256 };
  }

  async restore(record: PreparedToolCall): Promise<ComposeResult> {
    const artifact = await this.args.control.getArtifactByCall(this.args.runId, this.args.leaseId, record.callId);
    if (record.resultHash && artifact.sha256 !== record.resultHash) {
      throw new Error("unified_agent_html_restore_hash_mismatch");
    }
    return { html: "", artifact };
  }
}

function htmlDocument(result: ComposeResult): ApprovedHtmlDocument {
  const artifact = result.artifact;
  if (!artifact || artifact.role !== "html_document" || artifact.mime !== "text/html" ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new Error("unified_agent_html_artifact_invalid");
  }
  return { artifactId: artifact.artifactId, mime: "text/html", bytes: artifact.bytes, sha256: artifact.sha256 };
}

/** Approved compose_html keeps plan identity/resources parent-owned; only the bounded HTML body comes from DSH. */
export function createApprovedComposeHtmlToolDefinition(args: {
  runId: string;
  leaseId: string;
  approvedPlanHash: string;
  step: HarnessPlanStep;
  resourceArtifactIds: readonly string[];
  control: ApprovedHtmlControl;
  workspace: ApprovedHtmlWorkspace;
}): ToolGatewayDefinition {
  if (args.step.kind !== "compose_html" || !/^[0-9a-f]{64}$/.test(args.approvedPlanHash)) {
    throw new Error("unified_agent_html_compose_definition_invalid");
  }
  const resources = [...args.resourceArtifactIds];
  const dispatcher = new DurableToolDispatcher(args.control, new ApprovedComposeHtmlAdapter({
    runId: args.runId,
    leaseId: args.leaseId,
    stepId: args.step.id,
    control: args.control,
  }));
  return {
    name: "compose_html",
    execution: "durable",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    approvedPlanHash: args.approvedPlanHash,
    validate: (value) => validateComposeHtmlDocumentAction(value, resources),
    dispatcher: {
      async dispatch(identity: DurableToolIdentity, value: unknown) {
        if (identity.runId !== args.runId || identity.leaseId !== args.leaseId || identity.toolName !== "compose_html") {
          throw new Error("unified_agent_html_compose_identity_invalid");
        }
        const result = await dispatcher.dispatch(identity, value as ComposeHtmlDocumentActionV1);
        const artifact = htmlDocument(result);
        if (result.html) args.workspace.rememberHtmlDocument(result.artifact!, result.html);
        else args.workspace.rememberRemoteArtifact(result.artifact!);
        return artifact;
      },
    },
  };
}

function emptyArguments(value: unknown): Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error("approved_render_html_arguments_invalid");
  }
  return {};
}

/** render_html accepts no model parameters; the complete renderer request is supplied by the parent. */
export function createApprovedRenderHtmlToolDefinition<TResult>(args: {
  runId: string;
  leaseId: string;
  approvedPlanHash: string;
  step: HarnessPlanStep;
  input: RenderHtmlInputV1;
  executor: { render(request: { callId: string; phase: string; stepId: string; input: RenderHtmlInputV1 }): Promise<TResult> };
}): ToolGatewayDefinition {
  if (args.step.kind !== "render_html" || !/^[0-9a-f]{64}$/.test(args.approvedPlanHash)) {
    throw new Error("unified_agent_html_render_definition_invalid");
  }
  return {
    name: "render_html",
    execution: "durable",
    allowedPhases: ["execute_approved_plan"],
    requiresApproval: true,
    approvedPlanHash: args.approvedPlanHash,
    validate: emptyArguments,
    dispatcher: {
      async dispatch(identity: DurableToolIdentity) {
        if (identity.runId !== args.runId || identity.leaseId !== args.leaseId || identity.toolName !== "render_html") {
          throw new Error("unified_agent_html_render_identity_invalid");
        }
        return await args.executor.render({
          callId: identity.callId,
          phase: identity.phase,
          stepId: args.step.id,
          input: args.input,
        });
      },
    },
  };
}
