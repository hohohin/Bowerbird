import { ControlledImageEditRunProcessor } from "./controlled-run-processor.ts";
import { agentConfigFromEnv, runAgentWorker } from "./runtime.ts";
import { RunWorkspace } from "./run-workspace.ts";
import { DeepSeekBackend, deepSeekConfigFromEnv } from "../providers/deepseek/backend.ts";
import {
  arkControlledImageConfigFromEnv,
  createArkApprovedStepExecutor,
} from "../providers/ark/controlled-image-executor.ts";
import {
  arkFeedbackVisionConfigFromEnv,
  createArkFeedbackDiagnoser,
} from "../providers/ark/feedback-diagnoser.ts";

export function runControlledAgentWorker(env: Record<string, string | undefined>): Promise<void> {
  const worker = agentConfigFromEnv(env);
  const ark = arkControlledImageConfigFromEnv(env);
  const vision = arkFeedbackVisionConfigFromEnv(env);
  const workspaceRoot = env.AGENT_WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) throw new Error("AGENT_WORKSPACE_ROOT_missing");
  const processor = new ControlledImageEditRunProcessor(
    new DeepSeekBackend(deepSeekConfigFromEnv(env)),
    (context) => {
      const workspace = new RunWorkspace({
        root: workspaceRoot,
        runId: context.claimed.run.id,
        control: context.control,
        artifacts: context.claimed.artifactUrls,
      });
      return {
        executor: createArkApprovedStepExecutor({
          runId: context.claimed.run.id,
          leaseId: context.claimed.lease.leaseId,
          control: context.control,
          workspace,
          config: ark,
          signal: context.signal,
        }),
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
  );
  return runAgentWorker(worker, processor);
}
