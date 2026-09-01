import { ControlledImageEditRunProcessor } from "./controlled-run-processor.ts";
import {
  ControlledDshRunProcessor,
  type ControlledExecutorScope,
} from "./controlled-dsh-run-processor.ts";
import { HtmlLayoutRenderRunProcessor, SkillDispatchProcessor } from "./html-layout-run-processor.ts";
import { htmlRenderConfigFromEnv } from "../providers/renderer/html-render-executor.ts";
import { statfsSync } from "node:fs";
import { agentConfigFromEnv, runAgentWorker } from "./runtime.ts";
import { cleanupOrphanWorkspaces, RunWorkspace } from "./run-workspace.ts";
import {
  DeepSeekBackend,
  deepSeekConfigFromEnv,
  type DeepSeekConfig,
} from "../providers/deepseek/backend.ts";
import {
  arkControlledImageConfigFromEnv,
  createArkApprovedStepExecutor,
} from "../providers/ark/controlled-image-executor.ts";
import {
  arkFeedbackVisionConfigFromEnv,
  createArkFeedbackDiagnoser,
} from "../providers/ark/feedback-diagnoser.ts";
import { createLocalApprovedStepExecutor } from "../providers/local/local-approved-step-executor.ts";
import { UnifiedPlanningRunProcessor } from "./unified-planning-run-processor.ts";
import { DshAcpHarnessAdapter } from "../harness/dsh-acp-harness-adapter.ts";
import { NodeDshAcpPort } from "../harness/node-dsh-acp-port.ts";
import type { ArkAssetUnderstandingConfig } from "../harness/understand-asset-tool.ts";
import { DshModelBackend } from "../providers/deepseek/dsh-model-backend.ts";
import type { AgentRunContext } from "./runtime.ts";

function requiredUnifiedPath(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_missing`);
  return value;
}

const UNIFIED_DSH_MODEL = "deepseek-v4-flash";

function dshDeepSeekConfig(
  env: Record<string, string | undefined>,
  upstream: DeepSeekConfig,
): DeepSeekConfig {
  const model = env.BOWERBIRD_DSH_MODEL?.trim() || UNIFIED_DSH_MODEL;
  if (model !== UNIFIED_DSH_MODEL) throw new Error("BOWERBIRD_DSH_MODEL_mismatch");
  return { ...upstream, model };
}

/** Deployment-only DSH injection. Unset/false preserves the existing fail-closed dispatcher. */
export function unifiedPlanningProcessorFromEnv(
  env: Record<string, string | undefined>,
  workspaceRoot: string,
  vision: ArkAssetUnderstandingConfig,
  deepSeek: DeepSeekConfig,
  dependencies: { allowInsecureLoopback?: boolean } = {},
): UnifiedPlanningRunProcessor | undefined {
  const enabled = env.BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED?.trim();
  if (!enabled || enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED_invalid");

  const profileTemplateDir = requiredUnifiedPath(env, "BOWERBIRD_DSH_PROFILE_TEMPLATE");
  const runtimeRoot = requiredUnifiedPath(env, "BOWERBIRD_DSH_RUNTIME_ROOT");
  const renderConfig = htmlRenderConfigFromEnv(env);
  const dshDeepSeek = dshDeepSeekConfig(env, deepSeek);
  return new UnifiedPlanningRunProcessor({
    workspaceRoot,
    vision,
    createApprovedStepExecutor(context, workspace) {
      return createArkApprovedStepExecutor({
        runId: context.claimed.run.id,
        leaseId: context.claimed.lease.leaseId,
        control: context.control,
        workspace,
        config: arkControlledImageConfigFromEnv(env),
        signal: context.signal,
      });
    },
    modelProxy: {
      upstream: dshDeepSeek,
      ...(dependencies.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    },
    ...(renderConfig ? {
      htmlExecution: {
        renderConfig,
        createAdapter(childEnvironment, providerEnvironment, profileMode) {
          return new DshAcpHarnessAdapter({
            cwd: runtimeRoot,
            createPort: () => NodeDshAcpPort.create({
              profileTemplateDir,
              runtimeRoot,
              childEnvironment,
              providerEnvironment,
              parentEnvironment: env,
              profileMode,
            }),
          });
        },
      },
    } : {}),
    createAdapter(childEnvironment, providerEnvironment) {
      if (!providerEnvironment) throw new Error("dsh_model_proxy_environment_missing");
      return new DshAcpHarnessAdapter({
        cwd: runtimeRoot,
        createPort: () => NodeDshAcpPort.create({
          profileTemplateDir,
          runtimeRoot,
          childEnvironment,
          providerEnvironment,
          parentEnvironment: env,
        }),
      });
    },
  });
}

/** Deployment-only U4 injection. Per-Run selection remains authoritative in SkillDispatchProcessor. */
export function controlledDshProcessorFromEnv(
  env: Record<string, string | undefined>,
  deepSeek: DeepSeekConfig,
  executorFactory: (context: AgentRunContext) => ControlledExecutorScope,
  dependencies: { allowInsecureLoopback?: boolean } = {},
): ControlledDshRunProcessor | undefined {
  const enabled = env.BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED?.trim();
  if (!enabled || enabled === "false") return undefined;
  if (enabled !== "true") throw new Error("BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED_invalid");

  const profileTemplateDir = requiredUnifiedPath(env, "BOWERBIRD_DSH_PROFILE_TEMPLATE");
  const runtimeRoot = requiredUnifiedPath(env, "BOWERBIRD_DSH_RUNTIME_ROOT");
  const dshDeepSeek = dshDeepSeekConfig(env, deepSeek);
  return new ControlledDshRunProcessor({
    executorFactory,
    createModel(context) {
      return new DshModelBackend({
        runId: context.claimed.run.id,
        leaseId: context.claimed.lease.leaseId,
        control: context.control,
        upstream: dshDeepSeek,
        ...(dependencies.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
        createAdapter(childEnvironment, providerEnvironment) {
          return new DshAcpHarnessAdapter({
            cwd: runtimeRoot,
            createPort: () => NodeDshAcpPort.create({
              profileTemplateDir,
              runtimeRoot,
              childEnvironment,
              providerEnvironment,
              parentEnvironment: env,
              profileMode: "controlled-model",
            }),
          });
        },
      });
    },
  });
}

export function runControlledAgentWorker(env: Record<string, string | undefined>): Promise<void> {
  const worker = agentConfigFromEnv(env);
  const ark = arkControlledImageConfigFromEnv(env);
  const vision = arkFeedbackVisionConfigFromEnv(env);
  const deepSeek = deepSeekConfigFromEnv(env);
  const workspaceRoot = env.AGENT_WORKSPACE_ROOT?.trim();
  if (!workspaceRoot) throw new Error("AGENT_WORKSPACE_ROOT_missing");
  // HTML 排版 renderer 未配置时该 Skill 的 Run fail closed（processor 内 render_service_unavailable）。
  const renderConfig = htmlRenderConfigFromEnv(env);
  const executorFactory = (context: AgentRunContext): ControlledExecutorScope => {
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
  };
  const controlledProcessor = new ControlledImageEditRunProcessor(
    new DeepSeekBackend(deepSeek),
    executorFactory,
    { meteredModelName: deepSeek.model },
  );
  const htmlLayoutProcessor = new HtmlLayoutRenderRunProcessor(new DeepSeekBackend(deepSeek), {
    meteredModelName: deepSeek.model,
    ...(renderConfig ? { renderConfig } : {}),
    workspaceRoot,
  });
  const unifiedProcessor = unifiedPlanningProcessorFromEnv(env, workspaceRoot, vision, deepSeek);
  const controlledDshProcessor = controlledDshProcessorFromEnv(env, deepSeek, executorFactory);
  return runAgentWorker(worker, new SkillDispatchProcessor(
    controlledProcessor,
    htmlLayoutProcessor,
    unifiedProcessor,
    { controlledDsh: controlledDshProcessor },
  ), {
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
