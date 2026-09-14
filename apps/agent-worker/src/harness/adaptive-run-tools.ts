import type { AgentRunContext } from "../cloud-agent/runtime.ts";
import type { RunWorkspace } from "../cloud-agent/run-workspace.ts";
import type { ApprovedStepExecutor } from "../kernel/controlled-image-edit-runner.ts";
import { deriveCallId, sha256Hex, computeArgsHash } from "../kernel/tool-ledger.ts";
import type { TaskAuthorization } from "../contracts/task-authorization.ts";
import type { AdaptiveAction, AdaptiveJournal } from "./adaptive-tool-gateway.ts";
import type { ArkAssetUnderstandingConfig } from "./understand-asset-tool.ts";
import { createApprovedInspectArtifactToolDefinition } from "./understand-asset-tool.ts";
import { createApprovedGenerateImageToolDefinition } from "./approved-generate-image-tool.ts";
import { createApprovedComposeHtmlToolDefinition, createApprovedRenderHtmlToolDefinition } from "./approved-html-tools.ts";
import { ScopedToolGateway, type ToolGatewayDefinition } from "./scoped-tool-gateway.ts";
import type { HarnessPlanStep } from "./run-control-tools.ts";
import type { RenderHtmlInputV1, RenderHtmlResultV1 } from "../contracts/render-html.ts";
import { validateAdaptiveInputObject } from "./adaptive-tool-inputs.ts";

type ImageArtifact = { artifactId: string; sha256: string };
function text(value: unknown, max = 8000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("adaptive_text_invalid");
  return value;
}

/** Stateless tool methods share one Run workspace; no domain Agent/session is started. */
export class AdaptiveRunTools {
  private readonly images = new Map<string, ImageArtifact>();
  private readonly produced = new Set<string>();
  private readonly documents = new Map<string, string[]>();
  private readonly options: {
    context: AgentRunContext;
    workspace: RunWorkspace;
    authorization: TaskAuthorization;
    revision: number;
    vision: ArkAssetUnderstandingConfig;
    imageExecutor: ApprovedStepExecutor;
    renderExecutor?: { render(request: { callId: string; phase: string; stepId: string; input: RenderHtmlInputV1 }): Promise<RenderHtmlResultV1> };
    htmlOutput: Pick<RenderHtmlInputV1, "viewport" | "capture" | "background">;
    requiredTextLines: string[];
    journal: AdaptiveJournal;
  };
  constructor(options: {
    context: AgentRunContext;
    workspace: RunWorkspace;
    authorization: TaskAuthorization;
    revision: number;
    vision: ArkAssetUnderstandingConfig;
    imageExecutor: ApprovedStepExecutor;
    renderExecutor?: { render(request: { callId: string; phase: string; stepId: string; input: RenderHtmlInputV1 }): Promise<RenderHtmlResultV1> };
    htmlOutput: Pick<RenderHtmlInputV1, "viewport" | "capture" | "background">;
    requiredTextLines: string[];
    journal: AdaptiveJournal;
  }) {
    this.options = options;
    for (const artifact of options.context.claimed.artifactUrls ?? []) {
      if (options.authorization.assetIds.includes(artifact.artifactId)) this.images.set(artifact.artifactId, artifact);
    }
    for (const action of options.journal.actions) if (action.status === "completed") this.remember(action, action.result);
  }

  assets(): ImageArtifact[] { return [...this.images.values()]; }
  candidateIds(): string[] { return [...this.produced]; }

  private ids(value: unknown, producedOnly = false): string[] {
    if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length ||
        value.some((id) => typeof id !== "string" || !this.images.has(id) || producedOnly && !this.produced.has(id))) {
      throw new Error("adaptive_artifact_not_authorized");
    }
    return value as string[];
  }

  validate(toolName: string, value: unknown): unknown {
    if (toolName === "generate_image") {
      const raw = validateAdaptiveInputObject(toolName, value);
      return { prompt: text(raw.prompt), assetIds: this.ids(raw.assetIds) };
    }
    if (toolName === "inspect_artifact") {
      const raw = validateAdaptiveInputObject(toolName, value);
      const assetId = this.ids([raw.assetId])[0]!;
      if (!["general", "subject", "text", "layout", "style"].includes(String(raw.focus))) throw new Error("adaptive_focus_invalid");
      return { assetId, goal: text(raw.goal, 1000), focus: raw.focus };
    }
    if (toolName === "compose_html") {
      const raw = validateAdaptiveInputObject(toolName, value);
      const html = text(raw.html, 48_000);
      const assetIds = this.ids(raw.assetIds);
      const { context, workspace } = this.options;
      createApprovedComposeHtmlToolDefinition({ runId: context.claimed.run.id, leaseId: context.claimed.lease.leaseId,
        approvedPlanHash: context.claimed.run.approvedPlanHash!, resourceArtifactIds: assetIds,
        requiredTextLines: this.options.requiredTextLines, control: context.control, workspace,
        step: { id: "validate-html", kind: "compose_html", goal: "Validate document", inputAssetIds: [], dependsOn: [] },
      }).validate({ schemaVersion: 1, html, resourceArtifactIds: assetIds });
      return { html, assetIds };
    }
    if (toolName === "render_html") {
      const raw = validateAdaptiveInputObject(toolName, value);
      if (typeof raw.documentId !== "string" || !this.documents.has(raw.documentId)) throw new Error("adaptive_document_not_authorized");
      return { documentId: raw.documentId };
    }
    if (toolName === "finalize_output") {
      const raw = validateAdaptiveInputObject(toolName, value);
      const assetIds = this.ids(raw.assetIds, true);
      if (assetIds.length !== this.options.authorization.outputCount) throw new Error("adaptive_output_count_mismatch");
      return { assetIds };
    }
    throw new Error("adaptive_tool_unavailable");
  }

  private remember(action: AdaptiveAction, value: unknown): void {
    const result = value as Record<string, unknown>;
    if (action.toolName === "compose_html") {
      this.documents.set(String(result.artifactId), (action.arguments as { assetIds: string[] }).assetIds);
    }
    const images = action.toolName === "generate_image" ? [result]
      : action.toolName === "render_html" ? (result.outputs as Array<Record<string, unknown>>) : [];
    for (const image of images) {
      if (typeof image.artifactId !== "string" || typeof image.sha256 !== "string") throw new Error("adaptive_output_invalid");
      this.images.set(image.artifactId, { artifactId: image.artifactId, sha256: image.sha256 });
      this.produced.add(image.artifactId);
    }
  }

  async execute(action: AdaptiveAction): Promise<unknown> {
    const { context, workspace, authorization, revision } = this.options;
    if (context.signal.aborted) throw new Error("adaptive_cancelled");
    const { run, lease } = context.claimed;
    const approvedPlanHash = run.approvedPlanHash!;
    const args = action.arguments as Record<string, unknown>;
    const step: HarnessPlanStep = { id: action.actionId, kind: action.toolName as HarnessPlanStep["kind"],
      goal: String(args.prompt ?? args.goal ?? authorization.summary), inputAssetIds: [], dependsOn: [] };
    let definition: ToolGatewayDefinition;
    let input: unknown = {};
    if (action.toolName === "generate_image") {
      definition = createApprovedGenerateImageToolDefinition({ runId: run.id, conversationId: run.conversationId,
        approvedPlanHash, step, inputArtifactIds: args.assetIds as string[], outputRole: "stage_result",
        executor: this.options.imageExecutor });
    } else if (action.toolName === "inspect_artifact") {
      definition = createApprovedInspectArtifactToolDefinition({ runId: run.id, leaseId: lease.leaseId,
        approvedPlanHash, step, artifact: this.images.get(String(args.assetId))!, focus: args.focus as "general",
        control: context.control, workspace, config: this.options.vision, signal: context.signal });
    } else if (action.toolName === "compose_html") {
      definition = createApprovedComposeHtmlToolDefinition({ runId: run.id, leaseId: lease.leaseId,
        approvedPlanHash, step, resourceArtifactIds: args.assetIds as string[],
        requiredTextLines: this.options.requiredTextLines, control: context.control, workspace });
      input = { schemaVersion: 1, html: args.html, resourceArtifactIds: args.assetIds };
    } else if (action.toolName === "render_html") {
      if (!this.options.renderExecutor) throw new Error("adaptive_renderer_unavailable");
      definition = createApprovedRenderHtmlToolDefinition({ runId: run.id, leaseId: lease.leaseId,
        approvedPlanHash, step, executor: this.options.renderExecutor, input: {
          schemaVersion: 1, htmlArtifactId: String(args.documentId),
          resourceArtifactIds: this.documents.get(String(args.documentId))!, ...this.options.htmlOutput,
        } });
    } else if (action.toolName === "finalize_output") {
      const sourceCall = deriveCallId({ runId: run.id, phase: "execute_approved_plan", logicalSlot: action.slot, revisionIndex: revision });
      const artifactIds: string[] = [];
      for (const [index, id] of (args.assetIds as string[]).entries()) {
        const image = await workspace.readArtifact(id);
        const callId = sha256Hex(`${sourceCall}:final:${index}`);
        const prepared = await context.control.prepareTool({ runId: run.id, leaseId: lease.leaseId, callId,
          phase: "execute_approved_plan", toolName: "finalize_output", argsHash: computeArgsHash({ id, sha256: image.sha256 }) });
        if (prepared.status === "prepared") await context.control.markToolSubmitted({ runId: run.id, leaseId: lease.leaseId, callId });
        const artifact = await context.control.uploadArtifact({ runId: run.id, leaseId: lease.leaseId,
          sourceCallId: callId, stepId: action.actionId, parentArtifactId: id,
          role: "final_result", mime: image.mime, bytes: image.bytes, sha256: image.sha256, userVisible: true });
        await context.control.completeTool({ runId: run.id, leaseId: lease.leaseId, callId, status: "succeeded", resultObjectKey: artifact.objectKey, resultHash: image.sha256 });
        artifactIds.push(artifact.artifactId);
      }
      return { schemaVersion: 1, primaryArtifactId: artifactIds[0], visibleArtifactIds: artifactIds,
        terminalReason: "awaiting_result_feedback" };
    } else throw new Error("adaptive_tool_unavailable");
    const result = await new ScopedToolGateway([definition]).dispatch({ runId: run.id, leaseId: lease.leaseId,
      phase: "execute_approved_plan", approvedPlanHash, toolName: action.toolName, arguments: input,
      allowedTools: new Set([action.toolName]), trustedSlot: { logicalSlot: action.slot, revisionIndex: revision } });
    this.remember(action, result.value);
    return result.value;
  }
}
