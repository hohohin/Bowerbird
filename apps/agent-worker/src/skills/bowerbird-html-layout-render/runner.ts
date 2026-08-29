/**
 * HTML 排版 Run 引擎 —— H3-T4（HTML-RENDER-PLAN §6.3）。
 *
 * 纯 Kernel 状态推进 + 注入的副作用接口；每个相位迁移前先 checkpoint：
 *
 *   prepare_inputs（确定性）→ compose_html_document（唯一模型回合 + html_document artifact）
 *     → render_once（唯一一次 render_html；Executor 内部自带 durable/幂等语义）
 *     → awaiting_user_review（停车等用户；Kernel 不因等待自行推进）
 *         accept → exporting → succeeded
 *         discard（cancel 信号）→ cancelled
 *
 * 确定性不变量（H3-T5）：每 Run 至多一次 render（renderCallCount ∈ {0,1}）；
 * 无 Vision/revision 通路；awaiting_user_review 无决策输入时不产生任何模型/工具调用。
 */
import { loadHtmlLayoutRenderSkill } from "./loader.ts";
import { nextHtmlLayoutRenderPhase } from "./phase-graph.ts";
import { composeHtmlDocumentWithModel } from "./model-turn.ts";
import type { HtmlLayoutRunnerCheckpoint } from "./checkpoint.ts";
import type { ComposeHtmlDocumentActionV1, HtmlLayoutRenderInputV1 } from "./schemas.ts";
import type { RenderHtmlResultV1 } from "../../contracts/render-html.ts";
import type { ModelBackend } from "../../contracts/model.ts";

export type HtmlLayoutRunClaim = {
  runId: string;
  conversationId: string;
  skillVersion: string;
  /** 用户接受 = "accept"；放弃经 cancel 信号（cancelRequested），不占用该字段。 */
  resultFeedbackAction: "accept" | "retry" | null;
};

/** 注入的副作用接口（processor 提供；测试可替换）。 */
export interface HtmlLayoutEffects {
  saveHtmlDocument(action: ComposeHtmlDocumentActionV1): Promise<{ artifactId: string; sha256: string; bytes: number }>;
  renderHtml(htmlArtifactId: string): Promise<RenderHtmlResultV1 & { manifestArtifactId: string }>;
}

export interface HtmlLayoutControl {
  saveCheckpoint(checkpoint: HtmlLayoutRunnerCheckpoint, progress: number): Promise<void>;
  /** 停车等待用户接受/放弃；释放租约（映射 await_result_feedback）。 */
  awaitUserReview(checkpoint: HtmlLayoutRunnerCheckpoint): Promise<void>;
  finish(checkpoint: HtmlLayoutRunnerCheckpoint): Promise<void>;
  cancel(checkpoint: HtmlLayoutRunnerCheckpoint): Promise<void>;
}

export type HtmlLayoutRunOutcome = "awaiting_user_review" | "succeeded" | "cancelled" | "stopped";

export type AdvanceHtmlLayoutRunRequest = {
  claim: HtmlLayoutRunClaim;
  checkpoint?: HtmlLayoutRunnerCheckpoint;
  input?: HtmlLayoutRenderInputV1;
  model: ModelBackend;
  effects: HtmlLayoutEffects;
  control: HtmlLayoutControl;
  signal?: { cancelRequested: boolean; leaseLost: boolean; stopRequested: boolean };
};

function stopped(signal: AdvanceHtmlLayoutRunRequest["signal"]): boolean {
  return !!signal && (signal.cancelRequested || signal.leaseLost || signal.stopRequested);
}

function progressOf(checkpoint: HtmlLayoutRunnerCheckpoint): number {
  switch (checkpoint.phase) {
    case "prepare_inputs": return 5;
    case "compose_html_document": return 25;
    case "render_once": return 55;
    case "awaiting_user_review": return 80;
    case "exporting": return 95;
    case "succeeded": return 100;
    default: return 0;
  }
}

function assertPinnedIdentity(checkpoint: HtmlLayoutRunnerCheckpoint, claim: HtmlLayoutRunClaim): void {
  const skill = loadHtmlLayoutRenderSkill();
  if (checkpoint.runId !== claim.runId || checkpoint.conversationId !== claim.conversationId) {
    throw new Error("html_layout_checkpoint_identity_mismatch");
  }
  if (checkpoint.skillVersion !== claim.skillVersion || checkpoint.skillVersion !== skill.version ||
      checkpoint.skillHash !== skill.instructionHash) {
    throw new Error("html_layout_skill_mismatch");
  }
}

function createInitial(request: AdvanceHtmlLayoutRunRequest): HtmlLayoutRunnerCheckpoint {
  if (!request.input) throw new Error("html_layout_input_required");
  const skill = loadHtmlLayoutRenderSkill();
  if (request.claim.skillVersion !== skill.version) throw new Error("html_layout_skill_version_unavailable");
  return {
    schemaVersion: 1,
    runId: request.claim.runId,
    conversationId: request.claim.conversationId,
    skillId: "bowerbird-html-layout-render",
    skillVersion: skill.version,
    skillHash: skill.instructionHash,
    status: "running",
    phase: "prepare_inputs",
    input: request.input,
    pendingCompose: null,
    htmlDocument: null,
    renderCallCount: 0,
    renderResult: null,
    renderManifestArtifactId: null,
    artifacts: [],
  };
}

/** 把 render 结果并入 checkpoint（artifact 清单 + 计数；manifest 单独记 id）。 */
function recordRenderResult(checkpoint: HtmlLayoutRunnerCheckpoint, result: RenderHtmlResultV1 & { manifestArtifactId: string }): void {
  checkpoint.renderResult = result;
  checkpoint.renderManifestArtifactId = result.manifestArtifactId;
  checkpoint.renderCallCount = 1;
  checkpoint.artifacts.push(
    ...result.outputs.map((output) => ({
      artifactId: output.artifactId,
      role: output.role,
      ...(output.index !== undefined ? { index: output.index } : {}),
      bytes: output.bytes,
      sha256: output.sha256,
    })),
  );
}

/**
 * 推进一个已领取的 HTML 排版 Run 直到停车点或终态。
 */
export async function advanceHtmlLayoutRun(request: AdvanceHtmlLayoutRunRequest): Promise<{
  checkpoint: HtmlLayoutRunnerCheckpoint;
  outcome: HtmlLayoutRunOutcome;
}> {
  let checkpoint = request.checkpoint ?? createInitial(request);
  assertPinnedIdentity(checkpoint, request.claim);

  while (true) {
    if (stopped(request.signal)) {
      // 用户放弃（cancel）→ cancelled；其余停机原因保守停车，恢复后重放。
      if (request.signal?.cancelRequested && checkpoint.phase !== "succeeded" && checkpoint.phase !== "cancelled") {
        checkpoint.phase = nextHtmlLayoutRenderPhase(checkpoint.phase, "cancelled");
        checkpoint.status = "cancelled";
        await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
        await request.control.cancel(checkpoint);
        return { checkpoint, outcome: "cancelled" };
      }
      return { checkpoint, outcome: "stopped" };
    }

    switch (checkpoint.phase) {
      case "prepare_inputs": {
        checkpoint.phase = nextHtmlLayoutRenderPhase(checkpoint.phase, "inputs_prepared");
        await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
        break;
      }
      case "compose_html_document": {
        if (!checkpoint.htmlDocument) {
          // action 先入 checkpoint 再执行副作用：崩溃恢复按原文重放，保持 call argsHash 稳定。
          let action = checkpoint.pendingCompose;
          if (!action) {
            action = await composeHtmlDocumentWithModel({
              runId: checkpoint.runId,
              input: checkpoint.input,
              model: request.model,
              ...(request.signal
              ? { signal: { aborted: request.signal.cancelRequested || request.signal.leaseLost || request.signal.stopRequested } }
              : {}),
            });
            checkpoint.pendingCompose = action;
            await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
          }
          const saved = await request.effects.saveHtmlDocument(action);
          checkpoint.htmlDocument = {
            artifactId: saved.artifactId,
            role: "html_document",
            bytes: saved.bytes,
            sha256: saved.sha256,
          };
          checkpoint.artifacts.push(checkpoint.htmlDocument);
          checkpoint.pendingCompose = null;
        }
        checkpoint.phase = nextHtmlLayoutRenderPhase(checkpoint.phase, "html_composed");
        await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
        break;
      }
      case "render_once": {
        if (!checkpoint.htmlDocument) throw new Error("html_layout_render_without_document");
        // H3-T5 不变量：每 Run 至多一次 render；恢复路径靠 renderResult 幂等，不二次调用。
        if (!checkpoint.renderResult) {
          if (checkpoint.renderCallCount !== 0) throw new Error("html_layout_render_count_exceeded");
          const result = await request.effects.renderHtml(checkpoint.htmlDocument.artifactId);
          recordRenderResult(checkpoint, result);
        }
        checkpoint.phase = nextHtmlLayoutRenderPhase(checkpoint.phase, "render_completed");
        checkpoint.status = "awaiting_user_review";
        await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
        break;
      }
      case "awaiting_user_review": {
        if (request.claim.resultFeedbackAction === "retry") {
          // 本 Skill 无 revision phase；非法输入 fail closed（§6.3）。
          throw new Error("html_layout_retry_unsupported");
        }
        if (request.claim.resultFeedbackAction === "accept") {
          checkpoint.phase = nextHtmlLayoutRenderPhase(checkpoint.phase, "user_accepted");
          checkpoint.status = "running";
          await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
          break;
        }
        // 崩溃窗口恢复：checkpoint 已是 awaiting 但租约被重领 → 幂等重放停车请求。
        await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
        await request.control.awaitUserReview(checkpoint);
        return { checkpoint, outcome: "awaiting_user_review" };
      }
      case "exporting": {
        checkpoint.phase = nextHtmlLayoutRenderPhase(checkpoint.phase, "export_completed");
        checkpoint.status = "succeeded";
        await request.control.saveCheckpoint(checkpoint, progressOf(checkpoint));
        await request.control.finish(checkpoint);
        return { checkpoint, outcome: "succeeded" };
      }
      case "succeeded": {
        // 快照已 succeeded 但 finish 事务未落：重放。
        await request.control.finish(checkpoint);
        return { checkpoint, outcome: "succeeded" };
      }
      case "failed":
      case "cancelled":
        throw new Error(`html_layout_unexpected_phase:${checkpoint.phase}`);
    }
  }
}
