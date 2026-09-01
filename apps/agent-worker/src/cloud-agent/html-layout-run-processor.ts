/**
 * HTML 排版 Run Processor —— H3-T4b。
 *
 * 把纯 Kernel runner 接到控制面/工作区副作用：
 *   - compose_html_document 经 DurableToolDispatcher 落 html_document artifact（text/html，
 *     私有 userVisible=false），崩溃恢复按同 call id 内容寻址幂等；
 *   - render_html 走 H2 的 HtmlRenderExecutor（RENDERER_URL/RENDER_INTERNAL_TOKEN 缺失即
 *     fail closed，Run 安全失败）；
 *   - awaiting_user_review 复用 await_result_feedback 停车（accept）+ cancel 信号（放弃）；
 *   - 输入资源与 claim 的 input artifact 逐项复核（mime/bytes/sha256/顺序）。
 */
import type { ModelBackend } from "../contracts/model.ts";
import { MeteredModelBackend } from "../providers/deepseek/metered-model-backend.ts";
import { createHash } from "node:crypto";
import { deriveCallId } from "../kernel/tool-ledger.ts";
import {
  DurableToolDispatcher,
  type DurableToolAdapter,
} from "../kernel/durable-tool-dispatcher.ts";
import type { PreparedToolCall, RegisteredAgentArtifact } from "../control-plane/agent-control-client.ts";
import { AgentControlClient, AgentControlError } from "../control-plane/agent-control-client.ts";
import { BUILTIN_SKILL_REGISTRY } from "../skills/builtin-skill-registry.ts";
import { loadHtmlLayoutRenderSkill } from "../skills/bowerbird-html-layout-render/loader.ts";
import {
  decodeHtmlLayoutCheckpoint,
  encodeHtmlLayoutCheckpoint,
  type HtmlLayoutRunnerCheckpoint,
} from "../skills/bowerbird-html-layout-render/checkpoint.ts";
import { advanceHtmlLayoutRun, type HtmlLayoutControl, type HtmlLayoutEffects } from "../skills/bowerbird-html-layout-render/runner.ts";
import {
  validateHtmlLayoutRenderInput,
  type ComposeHtmlDocumentActionV1,
  type HtmlLayoutRenderInputV1,
} from "../skills/bowerbird-html-layout-render/schemas.ts";
import {
  createHtmlRenderExecutor,
  type HtmlRenderExecutorConfig,
  type HtmlRenderWorkspace,
} from "../providers/renderer/html-render-executor.ts";
import { RunWorkspace } from "./run-workspace.ts";
import type { AgentRunContext, AgentRunProcessor } from "./runtime.ts";
import { agentRuntimeForClaim } from "./agent-runtime.ts";

function reviewEvents(checkpoint: HtmlLayoutRunnerCheckpoint, progress: number) {
  const events = [];
  if (checkpoint.phase === "compose_html_document") {
    events.push({ seq: 10, type: "html.compose.started", progress, displayPayload: {} });
  }
  if (checkpoint.phase === "render_once") {
    events.push({
      seq: 20,
      type: "html.composed",
      progress,
      displayPayload: { artifactId: checkpoint.htmlDocument?.artifactId },
    });
  }
  if (checkpoint.phase === "awaiting_user_review" && checkpoint.renderResult) {
    events.push({
      seq: 30,
      type: "html.render.completed",
      progress,
      displayPayload: {
        rendererFingerprint: checkpoint.renderResult.rendererFingerprint,
        document: checkpoint.renderResult.document,
        outputs: checkpoint.renderResult.outputs.map((output) => ({
          artifactId: output.artifactId,
          role: output.role,
          index: output.index ?? null,
          widthDevicePx: output.clipDevicePx.width,
          heightDevicePx: output.clipDevicePx.height,
        })),
      },
    });
    events.push({ seq: 31, type: "result.ready", progress, displayPayload: {} });
  }
  if (checkpoint.phase === "exporting") {
    events.push({ seq: 40, type: "result.accepted", progress, displayPayload: {} });
  }
  if (checkpoint.phase === "succeeded") {
    events.push({ seq: 99, type: "run.succeeded", progress, displayPayload: {} });
  }
  return events;
}

/** compose_html_document 的 durable adapter：本地确定性产物（HTML 文本）+ 单 artifact 持久化。 */
type ComposeResult = { html: string; artifact?: RegisteredAgentArtifact };

class ComposeDocumentAdapter implements DurableToolAdapter<ComposeHtmlDocumentActionV1, ComposeResult> {
  private readonly runId: string;
  private readonly leaseId: string;
  private readonly control: AgentControlClient;

  constructor(args: { runId: string; leaseId: string; control: AgentControlClient }) {
    this.runId = args.runId;
    this.leaseId = args.leaseId;
    this.control = args.control;
  }

  async execute(_callId: string, request: ComposeHtmlDocumentActionV1): Promise<ComposeResult> {
    return { html: request.html };
  }

  async reconcile(callId: string, request: ComposeHtmlDocumentActionV1): Promise<ComposeResult | null> {
    void request;
    try {
      const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, callId);
      return { html: "", artifact };
    } catch (error) {
      if (error instanceof AgentControlError && error.status === 409) return null;
      throw error;
    }
  }

  async persist(_callId: string, result: ComposeResult) {
    if (result.artifact) {
      return { value: result, resultObjectKey: result.artifact.objectKey, resultHash: result.artifact.sha256 };
    }
    const bytes = new TextEncoder().encode(result.html);
    const artifact = await this.control.uploadArtifact({
      runId: this.runId,
      leaseId: this.leaseId,
      sourceCallId: _callId,
      role: "html_document",
      stepId: "compose",
      mime: "text/html",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      userVisible: false,
    });
    return { value: { ...result, artifact }, resultObjectKey: artifact.objectKey, resultHash: artifact.sha256 };
  }

  async restore(record: PreparedToolCall): Promise<ComposeResult> {
    const artifact = await this.control.getArtifactByCall(this.runId, this.leaseId, record.callId);
    if (record.resultHash && artifact.sha256 !== record.resultHash) throw new Error("html_layout_compose_restore_hash_mismatch");
    return { html: "", artifact };
  }
}

export class HtmlLayoutRenderRunProcessor implements AgentRunProcessor {
  private readonly model: ModelBackend;
  private readonly meteredModelName?: string;
  private readonly renderConfig: HtmlRenderExecutorConfig | undefined;
  private readonly workspaceRoot: string | undefined;

  constructor(model: ModelBackend, options: {
    meteredModelName?: string;
    renderConfig?: HtmlRenderExecutorConfig;
    workspaceRoot?: string;
  } = {}) {
    this.model = model;
    this.meteredModelName = options.meteredModelName;
    this.renderConfig = options.renderConfig;
    this.workspaceRoot = options.workspaceRoot;
  }

  async process(context: AgentRunContext): Promise<void> {
    const { run } = context.claimed;
    const registeredSkill = BUILTIN_SKILL_REGISTRY.resolve(run.skillId, run.skillVersion);
    if (registeredSkill.runner !== "html-layout-render") throw new Error("agent_skill_runner_mismatch");
    const skill = loadHtmlLayoutRenderSkill();

    // checkpoint 恢复或新 Run 输入
    let checkpoint: HtmlLayoutRunnerCheckpoint | undefined;
    const raw = await context.control.loadRawCheckpoint(context.claimed);
    if (raw) {
      if (run.snapshotSchemaVersion !== 1) throw new Error("agent_checkpoint_claim_incomplete");
      checkpoint = decodeHtmlLayoutCheckpoint(raw, {
        runId: run.id,
        conversationId: run.conversationId,
        skillVersion: run.skillVersion,
        skillHash: skill.instructionHash,
        sha256: run.checkpointHash ?? "",
      });
      BUILTIN_SKILL_REGISTRY.assertSnapshotCompatible(registeredSkill, checkpoint.schemaVersion);
    }
    let input: HtmlLayoutRenderInputV1 | undefined;
    if (!checkpoint) {
      if (!context.claimed.inputUrl) throw new Error("agent_input_url_missing");
      input = validateHtmlLayoutRenderInput(await context.control.downloadVerifiedJson(
        context.claimed.inputUrl,
        run.inputManifestHash,
      ));
      this.assertClaimedInputs(context, input);
    }

    // 副作用装配
    const runId = run.id;
    const leaseId = context.claimed.lease.leaseId;
    if (!this.workspaceRoot) throw new Error("agent_workspace_root_missing");
    if (!this.renderConfig) throw new Error("render_service_unavailable");
    const workspace = new RunWorkspace({
      root: this.workspaceRoot,
      runId,
      control: context.control,
      artifacts: context.claimed.artifactUrls,
    });
    const currentInput = checkpoint?.input ?? input!;
    try {
      const composeCallId = deriveCallId({ runId, phase: "compose_html_document", logicalSlot: 1, revisionIndex: 0 });
      const composeAdapter = new ComposeDocumentAdapter({ runId, leaseId, control: context.control });
      const composeDispatcher = new DurableToolDispatcher(context.control, composeAdapter);
      const renderExecutor = createHtmlRenderExecutor({
        runId,
        leaseId,
        control: context.control,
        workspace: workspace as HtmlRenderWorkspace,
        config: this.renderConfig,
      });
      const renderCallId = deriveCallId({ runId, phase: "render_once", logicalSlot: 1, revisionIndex: 0 });

      const effects: HtmlLayoutEffects = {
        saveHtmlDocument: async (action) => {
          const result = await composeDispatcher.dispatch(
            {
              runId,
              leaseId,
              callId: composeCallId,
              phase: "compose_html_document",
              toolName: "compose_html_document",
            },
            action,
          );
          const artifact = result.artifact;
          if (!artifact) throw new Error("html_layout_compose_artifact_missing");
          if (result.html) workspace.rememberHtmlDocument(artifact, result.html);
          else workspace.rememberRemoteArtifact(artifact);
          return { artifactId: artifact.artifactId, sha256: artifact.sha256, bytes: artifact.bytes };
        },
        renderHtml: async (htmlArtifactId) => {
          const resourceArtifactIds = currentInput.references.map((reference) => reference.artifactId);
          return await renderExecutor.render({
            callId: renderCallId,
            phase: "render_once",
            stepId: "render",
            input: {
              schemaVersion: 1,
              htmlArtifactId,
              resourceArtifactIds,
              viewport: currentInput.viewport,
              capture: currentInput.capture,
              background: currentInput.background,
            },
          });
        },
      };

      const control: HtmlLayoutControl = {
        saveCheckpoint: async (cp, progress) => {
          const encoded = encodeHtmlLayoutCheckpoint(cp);
          await context.control.saveRawCheckpoint({
            runId,
            leaseId,
            bytes: encoded.bytes,
            sha256: encoded.sha256,
            snapshotSchemaVersion: cp.schemaVersion,
            step: cp.phase,
            progress,
          });
          await context.control.appendEvents(runId, leaseId, reviewEvents(cp, progress));
        },
        awaitUserReview: async () => {
          await context.control.awaitResultFeedback(runId, leaseId);
        },
        finish: async () => {
          await context.control.finish(runId, leaseId);
        },
        cancel: async () => {
          await context.control.cancel(runId, leaseId);
        },
      };

      const model = this.meteredModelName
        ? new MeteredModelBackend({
            base: this.model,
            control: context.control,
            runId,
            leaseId,
            model: this.meteredModelName,
          })
        : this.model;

      const result = await advanceHtmlLayoutRun({
        claim: {
          runId,
          conversationId: run.conversationId,
          skillVersion: run.skillVersion,
          resultFeedbackAction: run.resultFeedbackAction,
        },
        ...(checkpoint ? { checkpoint } : {}),
        ...(input ? { input } : {}),
        model,
        effects,
        control,
        signal: context.signal,
      });
      void result;
    } finally {
      // 与 controlled processor 同款：非停车终态后清理工作区；awaiting 停车时保留输入缓存。
      workspace.cleanup();
    }
  }

  /** 输入引用必须与 claim 下发的 input artifact 完全一致（闭集，防跨 Run/伪造）。 */
  private assertClaimedInputs(context: AgentRunContext, input: HtmlLayoutRenderInputV1): void {
    const claimed = context.claimed.artifactUrls ?? [];
    for (const reference of input.references) {
      const artifact = claimed.find((candidate) => candidate.role === "input" && candidate.artifactId === reference.artifactId);
      if (!artifact || artifact.runId !== context.claimed.run.id ||
          artifact.conversationId !== context.claimed.run.conversationId ||
          artifact.mime !== reference.mime || artifact.bytes !== reference.bytes || artifact.sha256 !== reference.sha256) {
        throw new Error("agent_claim_input_artifact_mismatch");
      }
    }
  }
}

/** skill id → processor 分派（消费循环唯一入口）。 */
export class SkillDispatchProcessor implements AgentRunProcessor {
  private readonly controlled: AgentRunProcessor;
  private readonly htmlLayout: AgentRunProcessor;
  private readonly unified?: AgentRunProcessor;
  private readonly controlledDsh?: AgentRunProcessor;

  constructor(
    controlled: AgentRunProcessor,
    htmlLayout: AgentRunProcessor,
    unified?: AgentRunProcessor,
    options: { controlledDsh?: AgentRunProcessor } = {},
  ) {
    this.controlled = controlled;
    this.htmlLayout = htmlLayout;
    this.unified = unified;
    this.controlledDsh = options.controlledDsh;
  }

  async process(context: AgentRunContext): Promise<void> {
    const registered = BUILTIN_SKILL_REGISTRY.resolve(context.claimed.run.skillId, context.claimed.run.skillVersion);
    const runtime = agentRuntimeForClaim(context.claimed.run);
    if (registered.runner === "controlled-image-edit") {
      if (runtime === "dsh") {
        if (!this.controlledDsh) throw new Error("agent_runtime_unavailable");
        return await this.controlledDsh.process(context);
      }
      return await this.controlled.process(context);
    }
    if (registered.runner === "html-layout-render") {
      // U4 deliberately keeps the proven HTML runner on the legacy path.
      if (runtime !== "legacy_kernel") throw new Error("agent_runtime_skill_mismatch");
      return await this.htmlLayout.process(context);
    }
    if (registered.runner === "unified-agent") {
      if (!this.unified) throw new Error("agent_skill_runner_unavailable");
      return await this.unified.process(context);
    }
    throw new Error("agent_skill_runner_mismatch");
  }
}
