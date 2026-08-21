import type { AgentLeaseSignal } from "../../cloud-agent/runtime.ts";
import {
  AgentControlClient,
  AgentControlError,
  type LocalTaskRecord,
} from "../../control-plane/agent-control-client.ts";
import type {
  ApprovedStepExecutor,
  GenerateApprovedStepRequest,
  GeneratedApprovedStep,
} from "../../kernel/controlled-image-edit-runner.ts";
import { computeArgsHash } from "../../kernel/tool-ledger.ts";
import { DurableProviderError } from "../../kernel/durable-tool-dispatcher.ts";

/**
 * 本机 CLI 生图执行器：VPS 只负责编排，图片生成委托给用户桌面。
 *
 * 与 DurableToolDispatcher 的 Ark 路径同构，但 execute 无法同步完成——
 * 首次调用登记 agent_local_tasks（幂等 by run_id+call_id）后抛出
 * LocalTaskPendingError；引擎先 saveCheckpoint 再 local_task_await 停车
 * （释放租约，与审批暂停同款）。桌面执行完直传确定性 artifact key 并
 * 重新入队；本执行器在恢复路径上查询任务状态、复用既有 artifact commit
 * 校验登记结果并补 usage（provider=jimeng/codex，0 积分）。
 */
export class LocalTaskPendingError extends Error {
  readonly callId: string;

  constructor(callId: string) {
    super("local_task_pending");
    this.name = "LocalTaskPendingError";
    this.callId = callId;
  }
}

const LOCAL_RESULT_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

async function restoreStep(
  control: AgentControlClient,
  runId: string,
  leaseId: string,
  callId: string,
): Promise<GeneratedApprovedStep> {
  const artifact = await control.getArtifactByCall(runId, leaseId, callId);
  return { artifactId: artifact.artifactId, mime: artifact.mime, bytes: artifact.bytes, sha256: artifact.sha256 };
}

export function createLocalApprovedStepExecutor(args: {
  runId: string;
  leaseId: string;
  control: AgentControlClient;
  signal: AgentLeaseSignal;
  provider: "jimeng" | "codex";
  /** 从 claim 的 artifact 清单解析输入角色（input=本地参考图，其余=需下载的上一步产物）。 */
  artifactRole: (artifactId: string) => { role: string; stepId: string | null } | undefined;
}): ApprovedStepExecutor {
  const { runId, leaseId, control } = args;
  return {
    generate: async (request: GenerateApprovedStepRequest): Promise<GeneratedApprovedStep> => {
      if (args.signal.aborted) throw new Error("agent_execution_stopped");
      const record = await control.prepareTool({
        runId,
        leaseId,
        callId: request.callId,
        phase: "execute_approved_plan",
        toolName: "generate_image",
        argsHash: computeArgsHash(request),
      });
      if (record.status === "succeeded") return await restoreStep(control, runId, leaseId, request.callId);
      if (record.status === "failed") throw new DurableProviderError("terminal", "durable_tool_previously_failed");

      let task: LocalTaskRecord | null = null;
      try {
        task = await control.getLocalTaskStatus(runId, leaseId, request.callId);
      } catch (error) {
        if (!(error instanceof AgentControlError) || error.status !== 404) throw error;
      }
      if (!task) {
        // 先把副作用账本推到 submitted 再登记任务：崩溃在任何一点，恢复路径
        // 都能凭 (run_id, call_id) 找回或重建任务，不产生第二次生图。
        await control.markToolSubmitted({ runId, leaseId, callId: request.callId });
        task = await control.requestLocalTask({
          runId,
          leaseId,
          callId: request.callId,
          provider: args.provider,
          stepId: request.stepId,
          params: {
            prompt: request.prompt,
            ratio: request.ratio ?? null,
            inputs: request.inputArtifactIds.map((artifactId) => {
              const known = args.artifactRole(artifactId);
              return { artifactId, role: known?.role ?? "input", stepId: known?.stepId ?? null };
            }),
          },
        });
      }
      if (task.status === "pending") throw new LocalTaskPendingError(request.callId);

      if (task.status === "completed") {
        const mime = task.resultMime ?? "";
        const bytes = Number(task.resultBytes ?? 0);
        const sha256 = task.resultSha256 ?? "";
        if (!LOCAL_RESULT_MIMES.has(mime) || !/^[0-9a-f]{64}$/.test(sha256) ||
            !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 20 * 1024 * 1024) {
          throw new DurableProviderError("terminal", "local_task_result_invalid");
        }
        const artifact = await control.registerLocalArtifact({
          runId,
          leaseId,
          sourceCallId: request.callId,
          role: request.outputRole,
          stepId: request.stepId,
          parentArtifactId: request.parentArtifactId,
          mime: mime as "image/png" | "image/jpeg" | "image/webp",
          bytes,
          sha256,
        });
        await control.recordUsage({
          runId,
          leaseId,
          callId: request.callId,
          kind: "image_generation",
          provider: args.provider,
          model: args.provider === "codex" ? "codex-cli-imagegen" : "dreamina-cli",
          imageCount: 1,
        });
        await control.completeTool({
          runId,
          leaseId,
          callId: request.callId,
          status: "succeeded",
          resultObjectKey: artifact.objectKey,
          resultHash: artifact.sha256,
        });
        return { artifactId: artifact.artifactId, mime: artifact.mime, bytes: artifact.bytes, sha256: artifact.sha256 };
      }

      await control.completeTool({
        runId,
        leaseId,
        callId: request.callId,
        status: "failed",
        safeErrorCode: task.errorCode ?? "local_task_failed",
      });
      throw new DurableProviderError("terminal", task.errorCode ?? "local_task_failed");
    },
  };
}
