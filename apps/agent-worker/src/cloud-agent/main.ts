import { ControlledImageEditRunProcessor } from "./controlled-run-processor.ts";
import { statfsSync } from "node:fs";
import { agentConfigFromEnv, runAgentWorker } from "./runtime.ts";
import { cleanupOrphanWorkspaces, RunWorkspace } from "./run-workspace.ts";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import {
  arkControlledImageConfigFromEnv,
  createArkApprovedStepExecutor,
} from "../providers/ark/controlled-image-executor.ts";
import {
  arkFeedbackVisionConfigFromEnv,
  createArkFeedbackDiagnoser,
} from "../providers/ark/feedback-diagnoser.ts";
import { createLocalApprovedStepExecutor } from "../providers/local/local-approved-step-executor.ts";

export function runControlledAgentWorker(env: Record<string, string | undefined>): Promise<void> {
  const worker = agentConfigFromEnv(env);
  const ark = arkControlledImageConfigFromEnv(env);
  const vision = arkFeedbackVisionConfigFromEnv(env);
  const deepSeek = deepSeekConfigFromEnv(env);
  const workspaceRoot = env.AGENT_WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) throw new Error("AGENT_WORKSPACE_ROOT_missing");
  const processor = new ControlledImageEditRunProcessor(
    new DeepSeekBackend(deepSeek),
    (context) => {
      const workspace = new RunWorkspace({
        root: workspaceRoot,
        runId: context.claimed.run.id,
        control: context.control,
        artifacts: context.claimed.artifactUrls,
      });
      // BYO Run：文本/审批/编排仍在 VPS，生图步骤委托桌面本地执行（VPS 不共享用户账号）。
      const localProvider = context.claimed.run.imageProvider === "jimeng" ||
          context.claimed.run.imageProvider === "codex"
        ? context.claimed.run.imageProvider
        : null;
      const executor = localProvider
        ? createLocalApprovedStepExecutor({
            runId: context.claimed.run.id,
            leaseId: context.claimed.lease.leaseId,
            control: context.control,
            signal: context.signal,
            provider: localProvider,
            artifactRole: (artifactId) => {
              const artifact = (context.claimed.artifactUrls ?? []).find((item) => item.artifactId === artifactId);
              return artifact ? { role: artifact.role, stepId: artifact.stepId ?? null } : undefined;
            },
          })
        : createArkApprovedStepExecutor({
            runId: context.claimed.run.id,
            leaseId: context.claimed.lease.leaseId,
            control: context.control,
            workspace,
            config: ark,
            signal: context.signal,
          });
      return {
        executor,
        diagnoser: createArkFeedbackDiagnoser({
          runId: context.claimed.run.id,
          leaseId: context.claimed.lease.leaseId,
          control: context.control,
          workspace,
          config: vision,
          signal: context.signal,
        }),
        cleanup: () => workspace.cleanup(),
      };
    },
    { meteredModelName: deepSeek.model },
  );
  return runAgentWorker(worker, processor, {
    maintenance: async (control) => {
      const removed = cleanupOrphanWorkspaces(workspaceRoot);
      const cloud = await control.cleanupExpired();
      const metrics = await control.metrics();
      const disk = statfsSync(workspaceRoot);
      const totalBytes = disk.blocks * disk.bsize;
      const availableBytes = disk.bavail * disk.bsize;
      console.log(JSON.stringify({
        event: "agent_health",
        orphan_workspaces: removed,
        cleanup: cloud,
        control_plane: metrics,
        workspace: {
          total_bytes: totalBytes,
          used_bytes: Math.max(0, totalBytes - availableBytes),
          used_ratio: totalBytes > 0 ? (totalBytes - availableBytes) / totalBytes : null,
        },
      }));
    },
  });
}
