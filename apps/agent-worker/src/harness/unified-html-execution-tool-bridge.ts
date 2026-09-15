import { RunContextTools } from "./run-context-tools.ts";
import type { ApprovedHtmlDocument } from "./approved-html-tools.ts";
import { DurableProviderError } from "../kernel/durable-tool-dispatcher.ts";
import { computeArgsHash } from "../kernel/tool-ledger.ts";
import type { HarnessModelToolCall } from "./unified-planning-tool-bridge.ts";
import {
  ScopedToolGateway,
  ToolGatewayError,
  type ToolGatewayDefinition,
  type ToolGatewayResult,
} from "./scoped-tool-gateway.ts";

type HtmlExecutionToolName = "compose_html" | "render_html" | "inspect_artifact" | "compose_xiaohongshu" | "finalize_output";

/** Parent-owned bridge for one approved HTML sequence; every identity and artifact choice stays outside DSH. */
export class UnifiedHtmlExecutionToolBridge<TRender, TInspection = unknown, TFinal = unknown, TSocial = unknown> {
  readonly runId: string;
  private readonly leaseId: string;
  private readonly approvedPlanHash: string;
  private readonly revisionIndex: number;
  private readonly composeSlot: number;
  private readonly renderSlot: number;
  private readonly inspectSlot?: number;
  private readonly socialSlot?: number;
  private readonly finalizeSlot: number;
  private readonly composeGateway: ScopedToolGateway;
  private readonly createRenderDefinition: (document: ApprovedHtmlDocument) => ToolGatewayDefinition;
  private readonly createInspectDefinition?: (render: TRender) => ToolGatewayDefinition;
  private readonly createSocialDefinition?: (render: TRender, inspection?: TInspection) => ToolGatewayDefinition;
  private readonly createFinalizeDefinition: (render: TRender, inspection?: TInspection, social?: TSocial) => ToolGatewayDefinition;
  private documentValue?: ApprovedHtmlDocument;
  private readonly contextTools: RunContextTools;
  private failureCode?: string;

  get lastErrorCode(): string | undefined { return this.failureCode; }
  private renderValue?: TRender;
  private inspectionValue?: TInspection;
  private socialValue?: TSocial;
  private finalValue?: TFinal;
  private completedValue: Array<ToolGatewayResult & { toolName: HtmlExecutionToolName; argsHash: string }> = [];

  constructor(args: {
    runId: string;
    leaseId: string;
    approvedPlanHash: string;
    revisionIndex?: number;
    composeSlot: number;
    renderSlot: number;
    inspectSlot?: number;
    socialSlot?: number;
    finalizeSlot: number;
    composeDefinition: ToolGatewayDefinition;
    contextTools?: RunContextTools;
    createRenderDefinition(document: ApprovedHtmlDocument): ToolGatewayDefinition;
    createInspectDefinition?(render: TRender): ToolGatewayDefinition;
    createSocialDefinition?(render: TRender, inspection?: TInspection): ToolGatewayDefinition;
    createFinalizeDefinition(render: TRender, inspection?: TInspection, social?: TSocial): ToolGatewayDefinition;
  }) {
    const predecessorSlot = args.inspectSlot ?? args.renderSlot;
    if (!/^[0-9a-f]{64}$/.test(args.approvedPlanHash) ||
        !Number.isSafeInteger(args.composeSlot) || args.composeSlot < 0 ||
        !Number.isSafeInteger(args.renderSlot) || args.renderSlot <= args.composeSlot ||
        !Number.isSafeInteger(args.finalizeSlot) || args.finalizeSlot <= args.renderSlot ||
        (args.inspectSlot !== undefined && (!Number.isSafeInteger(args.inspectSlot) || args.inspectSlot <= args.renderSlot || args.inspectSlot >= args.finalizeSlot)) ||
        (args.inspectSlot === undefined) !== (args.createInspectDefinition === undefined) ||
        (args.socialSlot !== undefined && (!Number.isSafeInteger(args.socialSlot) || args.socialSlot <= predecessorSlot || args.socialSlot >= args.finalizeSlot)) ||
        (args.socialSlot === undefined) !== (args.createSocialDefinition === undefined)) {
      throw new Error("unified_agent_html_bridge_invalid");
    }
    this.contextTools = args.contextTools ?? new RunContextTools([]);
    this.runId = args.runId;
    this.leaseId = args.leaseId;
    this.approvedPlanHash = args.approvedPlanHash;
    this.revisionIndex = args.revisionIndex ?? 0;
    this.composeSlot = args.composeSlot;
    this.renderSlot = args.renderSlot;
    this.inspectSlot = args.inspectSlot;
    this.socialSlot = args.socialSlot;
    this.finalizeSlot = args.finalizeSlot;
    this.composeGateway = new ScopedToolGateway([args.composeDefinition]);
    this.createRenderDefinition = args.createRenderDefinition;
    this.createInspectDefinition = args.createInspectDefinition;
    this.createSocialDefinition = args.createSocialDefinition;
    this.createFinalizeDefinition = args.createFinalizeDefinition;
  }

  get document(): ApprovedHtmlDocument | undefined {
    return this.documentValue;
  }

  get renderResult(): TRender | undefined {
    return this.renderValue;
  }

  get inspectionResult(): TInspection | undefined {
    return this.inspectionValue;
  }

  get socialResult(): TSocial | undefined {
    return this.socialValue;
  }

  get finalResult(): TFinal | undefined {
    return this.finalValue;
  }

  get completedCalls(): readonly (ToolGatewayResult & { toolName: HtmlExecutionToolName; argsHash: string })[] {
    return this.completedValue;
  }

  async dispatch(call: HarnessModelToolCall): Promise<ToolGatewayResult> {
    try {
      const contextResult = this.contextTools.dispatch(call);
      if (contextResult) return contextResult;
      return await this.dispatchTool(call);
    } catch (error) {
      if (error instanceof DurableProviderError) this.failureCode = error.safeCode;
      if (call.toolName === "compose_html" && error instanceof ToolGatewayError &&
          error.validationCode?.startsWith("approved_html_preflight:")) {
        return { callId: "validation", value: {
          status: "retry_required",
          errorCode: "render_html_unsafe",
          correction: `HTML preflight rejected ${error.validationCode.slice(24)}. Correct the document and call compose_html again. Image width/height attributes must be integers; use style="height:auto" or omit the height attribute for automatic sizing. No document has been committed.`,
        } };
      }
      throw error;
    }
  }

  private async dispatchTool(call: HarnessModelToolCall): Promise<ToolGatewayResult> {
    if (call.toolName === "compose_html") {
      if (this.documentValue !== undefined || this.renderValue !== undefined || this.finalValue !== undefined) throw new ToolGatewayError("tool_sequence_invalid");
      const result = await this.composeGateway.dispatch({
        runId: this.runId,
        leaseId: this.leaseId,
        phase: "execute_approved_plan",
        toolName: "compose_html",
        arguments: call.arguments,
        trustedSlot: { logicalSlot: this.composeSlot, revisionIndex: this.revisionIndex },
        allowedTools: new Set(["compose_html"]),
        approvedPlanHash: this.approvedPlanHash,
      });
      this.documentValue = result.value as ApprovedHtmlDocument;
      this.completedValue = [...this.completedValue.filter((item) => item.callId !== result.callId), {
        ...result, toolName: "compose_html", argsHash: computeArgsHash(call.arguments),
      }];
      return result;
    }
    if (call.toolName === "render_html") {
      if (!this.documentValue || this.renderValue !== undefined || this.finalValue !== undefined) throw new ToolGatewayError("tool_sequence_invalid");
      const gateway = new ScopedToolGateway([this.createRenderDefinition(this.documentValue)]);
      const result = await gateway.dispatch({
        runId: this.runId,
        leaseId: this.leaseId,
        phase: "execute_approved_plan",
        toolName: "render_html",
        arguments: call.arguments,
        trustedSlot: { logicalSlot: this.renderSlot, revisionIndex: this.revisionIndex },
        allowedTools: new Set(["render_html"]),
        approvedPlanHash: this.approvedPlanHash,
      });
      this.renderValue = result.value as TRender;
      this.completedValue = [...this.completedValue.filter((item) => item.callId !== result.callId), {
        ...result, toolName: "render_html", argsHash: computeArgsHash(call.arguments),
      }];
      return result;
    }
    if (call.toolName === "inspect_artifact") {
      if (!this.renderValue || this.inspectSlot === undefined || !this.createInspectDefinition ||
          this.inspectionValue !== undefined || this.finalValue !== undefined) {
        throw new ToolGatewayError("tool_sequence_invalid");
      }
      const gateway = new ScopedToolGateway([this.createInspectDefinition(this.renderValue)]);
      const result = await gateway.dispatch({
        runId: this.runId,
        leaseId: this.leaseId,
        phase: "execute_approved_plan",
        toolName: "inspect_artifact",
        arguments: call.arguments,
        trustedSlot: { logicalSlot: this.inspectSlot, revisionIndex: this.revisionIndex },
        allowedTools: new Set(["inspect_artifact"]),
        approvedPlanHash: this.approvedPlanHash,
      });
      this.inspectionValue = result.value as TInspection;
      this.completedValue = [...this.completedValue.filter((item) => item.callId !== result.callId), {
        ...result, toolName: "inspect_artifact", argsHash: computeArgsHash(call.arguments),
      }];
      return result;
    }
    if (call.toolName === "compose_xiaohongshu") {
      if (!this.renderValue || this.socialSlot === undefined || !this.createSocialDefinition ||
          (this.inspectSlot !== undefined && this.inspectionValue === undefined) ||
          this.socialValue !== undefined || this.finalValue !== undefined) {
        throw new ToolGatewayError("tool_sequence_invalid");
      }
      const gateway = new ScopedToolGateway([this.createSocialDefinition(this.renderValue, this.inspectionValue)]);
      const result = await gateway.dispatch({
        runId: this.runId,
        leaseId: this.leaseId,
        phase: "execute_approved_plan",
        toolName: "compose_xiaohongshu",
        arguments: call.arguments,
        trustedSlot: { logicalSlot: this.socialSlot, revisionIndex: this.revisionIndex },
        allowedTools: new Set(["compose_xiaohongshu"]),
        approvedPlanHash: this.approvedPlanHash,
      });
      this.socialValue = result.value as TSocial;
      this.completedValue = [...this.completedValue.filter((item) => item.callId !== result.callId), {
        ...result, toolName: "compose_xiaohongshu", argsHash: computeArgsHash(call.arguments),
      }];
      return result;
    }
    if (call.toolName === "finalize_output") {
      if (!this.renderValue || this.finalValue !== undefined ||
          (this.inspectSlot !== undefined && this.inspectionValue === undefined) ||
          (this.socialSlot !== undefined && this.socialValue === undefined)) {
        throw new ToolGatewayError("tool_sequence_invalid");
      }
      const gateway = new ScopedToolGateway([this.createFinalizeDefinition(this.renderValue, this.inspectionValue, this.socialValue)]);
      const result = await gateway.dispatch({
        runId: this.runId,
        leaseId: this.leaseId,
        phase: "execute_approved_plan",
        toolName: "finalize_output",
        arguments: call.arguments,
        trustedSlot: { logicalSlot: this.finalizeSlot, revisionIndex: this.revisionIndex },
        allowedTools: new Set(["finalize_output"]),
        approvedPlanHash: this.approvedPlanHash,
      });
      this.finalValue = result.value as TFinal;
      this.completedValue = [...this.completedValue.filter((item) => item.callId !== result.callId), {
        ...result, toolName: "finalize_output", argsHash: computeArgsHash(call.arguments),
      }];
      return result;
    }
    throw new ToolGatewayError("tool_not_registered");
  }
}
