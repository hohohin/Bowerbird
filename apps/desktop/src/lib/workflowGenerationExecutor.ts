import { api } from "./api";
import type { Asset, ProjectCanvasSnapshot } from "./types";
import { DEFAULT_VIDEO_OPTIONS, resolveVideoOptions, videoInputError, isVideoPath } from "./videoGeneration";
import { workflowGenerationProvider, workflowProviderIssue } from "./workflowProviderIssue";
import { useStore } from "../store";
import { WorkflowNodeError } from "./workflowDiagnostics";
import { comfyEnvironment, comfyEnvironmentReady, H3_IMAGE_ENDPOINT } from "./comfyVideo";
import { h3OptimizationInstruction } from "./h3PromptOptimization";
import { compileGenerationPrompt, type WorkflowNode, type WorkflowStep, type WorkflowValue, renderGenerationDraft, type H3ImageGenerationInput } from "./canvasWorkflow";
import type { WorkflowExecutionHost, CardStart } from "./workflowExecutionHost";
import { resolveComfyPromptOptimization, applyAutoOptimizedDraft } from "./workflowComfyExecutor";
import { isAudioPath } from "./audioMedia";

export async function runWorkflowImageSession(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, input?: {
  prompt: string; rawPrompt: string; references: Asset[]; ratio: string | null; visualProfileId: string | null; referenceNodeIds: (string | null)[];
  generationRunInput?: WorkflowStep["generationRunInput"];
}) {
  const id = node.id, step = host.run(runId).steps[id];
  let { jobId, turnKey } = step;
  if (!jobId) {
    const optimizedForThisRun = !!(step.comfyAutoGeneration?.imageInput && step.comfyOptimization?.result);
    if (!input || step.status !== "pending" && !optimizedForThisRun) throw new Error("无法确认上次提交状态，请检查任务中心");
    jobId = crypto.randomUUID(); turnKey = crypto.randomUUID();
    const sessionNodeId = `gen-prompt:${jobId}:${turnKey}:0`;
    // Persist both recovery identity and ownership before calling the provider.
    const run = host.run(runId);
    await host.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], status: "running", jobId, turnKey, generationSubmission: "pending",
      generationRunInput: input.generationRunInput ?? run.steps[id].generationRunInput } } },
      host.document.nodes.map(candidate => candidate.id === id ? { ...candidate, activeSessionNodeId: sessionNodeId,
        sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate));
    if (halted()) return;
    if (optimizedForThisRun && run.accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) {
      throw new Error("账号已切换，请登录原账号后重新运行");
    }
    const result = await useStore.getState().startGeneration(input.prompt, input.references, input.ratio, workflowGenerationProvider(node),
      input.rawPrompt, undefined, undefined, undefined, input.visualProfileId,
      { projectId: host.projectId, threadId: run.threadId, referenceNodeIds: input.referenceNodeIds }, true, undefined, { jobId, turnKey });
    if (!result.accepted) throw new Error(result.error || "生成任务未提交");
  } else if (step.generationSubmission !== "submitted") {
    if (!turnKey || !await api.agentDsWorkflowGenerationJob(jobId, turnKey)) {
      await host.step(runId, id, { status: "waiting", error: "无法确认原生成任务是否已提交，请检查任务中心后继续；不会重复提交" }); return;
    }
  }
  if (halted()) return;
  if (!turnKey) throw new Error("原生成任务缺少轮次身份，请检查原任务");
  host.registerGenerationHandoff(id, { runId, jobId, turnKey });
  await host.step(runId, id, { generationSubmission: "submitted", detail: "生成任务已提交" });
  if (!await host.deliverSubmittedSessions(runId, node, halted)) return;
  await host.finish(runId, node, { image: { type: "image", nodeIds: [`gen-prompt:${jobId}:${turnKey}:0`] } });
}

export async function recoverVideoResult(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean) {
  const step = host.run(runId).steps[node.id];
  if (!step.jobId || !step.turnKey) throw new Error("原视频任务缺少恢复标识，无法自动取回；可删除此卡片，不会重新提交生成");
  let result;
  try {
    // Query the durable job and turn directly. Recent-session lists omit active and older jobs.
    result = await api.agentDsWorkflowGenerationJob(step.jobId, step.turnKey);
  } catch (error) {
    if (!halted()) await host.step(runId, node.id, { status: "waiting", error: `查询原视频任务失败，请稍后继续取回：${String(error)}` });
    return;
  }
  if (halted()) return;
  if (!result) throw new Error("未找到原视频任务记录，无法自动取回；可删除此卡片，不会重新提交生成");
  if (["failed", "cancelled", "cancelled_local"].includes(result.status)) throw new Error(result.error || (result.status === "failed" ? "原视频任务已失败" : "原视频任务已停止"));
  if (result.status !== "done") {
    await host.step(runId, node.id, { status: "waiting", videoJobActive: true, error: "原视频仍在生成或恢复中，完成后可继续取回。" });
    return;
  }
  const assetIds = await Promise.all(result.images.map(path => api.localAgentFindAssetId(path)));
  if (halted()) return;
  if (!assetIds.length || assetIds.some(id => !id)) throw new Error("原视频任务已结束，但本地结果已缺失；请检查素材库或任务中心，可删除此卡片");
  await host.finish(runId, node, { image: { type: "image", assetIds: [...new Set(assetIds as string[])] } });
}

export async function runComfyAutoImage(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, image: H3ImageGenerationInput, start?: CardStart) {
  if (host.run(runId).steps[node.id].jobId) {
    await runWorkflowImageSession(host, runId, node, halted);
    return;
  }
  const optimized = await resolveComfyPromptOptimization(host, runId, node, halted, start);
  if (!optimized || halted()) return;
  await applyAutoOptimizedDraft(host, runId, node.id, optimized.result);
  if (halted()) return;
  const assets = image.assetIds.length ? await api.getAssetsByIds(image.assetIds) : [];
  const references = image.assetIds.map(id => {
    const asset = assets.find(asset => asset.id === id);
    if (!asset?.store_path || asset.duration || isVideoPath(asset.store_path) || isAudioPath(asset.store_path)) {
      throw new Error("参考图已缺失，请检查素材后重新运行");
    }
    return asset;
  });
  if (halted()) return;
  await runWorkflowImageSession(host, runId, node, halted, {
    ...image, references, prompt: image.promptParts ? renderGenerationDraft(optimized.result, image.promptParts) : optimized.result,
    rawPrompt: image.promptParts ? renderGenerationDraft(optimized.input.prompt, image.promptParts) : optimized.input.prompt,
  });
}

export async function executeGeneration(host: WorkflowExecutionHost, runId: string, node: WorkflowNode,
  step: WorkflowStep, halted: () => boolean, { video, orderedAssets, connectedNode, values, canvas, prompt, assetIds, visualProfileId, generated, generationRunInput, start }: {
    video: boolean;
    orderedAssets: Asset[];
    connectedNode: WorkflowNode;
    values: Record<string, WorkflowValue[]>;
    canvas: ProjectCanvasSnapshot | null;
    prompt: string;
    assetIds: string[];
    visualProfileId: string | null;
    generated: ReturnType<typeof compileGenerationPrompt> | null;
    generationRunInput: WorkflowStep["generationRunInput"];
    start: CardStart | undefined;
  }) {
  const id = node.id;
  const generation = video ? { ...node.generation, media: "video" as const, videoOptions: resolveVideoOptions(node.generation?.videoOptions ?? DEFAULT_VIDEO_OPTIONS, orderedAssets) } : undefined;
  const provider = workflowGenerationProvider(node);
  if (!step.jobId) {
    const issue = workflowProviderIssue(node, useStore.getState());
    if (issue) throw new WorkflowNodeError(issue.message, node);
  }
  const ratio = generation ? generation.ratio ?? "16:9" : node.ratio;
  const sessionOutput = !video && (!step.jobId || !!step.generationSubmission);
  if (sessionOutput) {
    if (!step.jobId) {
      if (step.status !== "pending") throw new Error("无法确认上次提交状态，请检查任务中心");
      const origins = new Map<string, string>();
      for (const [port, bindings] of Object.entries(connectedNode.inputs)) for (const [index, binding] of bindings.entries()) {
        const sourceId = binding.assetNodeId ?? binding.canvasNodeId;
        if (sourceId && values[port]?.[index]?.assetIds?.length) {
          canvas ??= await api.projectCanvasGet(host.projectId);
          if (halted()) return;
          const source = canvas?.nodes.find(candidate => candidate.id === sourceId && candidate.kind === "asset" && candidate.hiddenAt == null);
          if (source?.assetId && values[port][index].assetIds?.includes(source.assetId) && !origins.has(source.assetId)) {
            origins.set(source.assetId, source.id);
          }
        }
      }
      // Explicit null keeps a reference in the request and history without projecting a canvas node.
      const referenceNodeIds = orderedAssets.map(asset => origins.get(asset.id) ?? null);
      if (step.comfyAutoGeneration) {
        if (prompt.length > 16000) throw new Error("自动优化支持 1–16000 字提示词");
        const environment = await comfyEnvironment("detect", H3_IMAGE_ENDPOINT, undefined, undefined, orderedAssets.length ? "edit" : "image");
        if (halted()) return;
        if (!comfyEnvironmentReady(environment)) throw new WorkflowNodeError(environment.message || "本地 H3 图片环境尚未就绪。", node);
        const imageInput = { assetIds, referenceNodeIds, ratio, visualProfileId, promptParts: generated?.promptParts };
        const input = { prompt: node.prompt, referenceCount: orderedAssets.length, ratio: ratio?.trim() || "auto" };
        await host.step(runId, id, { generationRunInput, comfyAutoGeneration: { imageInput },
          comfyOptimization: { input, instruction: h3OptimizationInstruction(input), createdAt: Date.now(),
            inputBindings: JSON.stringify([node.inputs, node.promptReferences]) } });
        if (!halted()) await runComfyAutoImage(host, runId, node, halted, imageInput, start);
      } else {
        await runWorkflowImageSession(host, runId, node, halted, { prompt, rawPrompt: prompt, references: orderedAssets, ratio, visualProfileId, referenceNodeIds, generationRunInput });
      }
    } else {
      await runWorkflowImageSession(host, runId, node, halted);
    }
    return;
  }
  let paths: string[] = [];
  if (step.jobId) {
    const previous = (await api.recentGenSessions(500)).find(job => job.id === step.jobId);
    if (!previous || previous.status !== "done") {
      if (previous?.status === "failed") throw new Error(previous.error || "生成失败");
      await host.step(runId, id, { status: "waiting", error: "原任务尚未完成，请稍后继续取回" }); return;
    }
    const turn = step.turnKey ? previous.turns.find(turn => turn.turn_key === step.turnKey) : previous.turns[0];
    paths = turn?.images ?? [];
  } else {
    if (step.status !== "pending") throw new Error("无法确认上次提交状态，请检查任务中心");
    if (generation) {
      const error = videoInputError(generation.videoOptions, orderedAssets, ratio, provider);
      if (error) throw new Error(error);
    }
    const identity = { jobId: crypto.randomUUID(), turnKey: crypto.randomUUID() };
    const sessionNodeId = `gen-prompt:${identity.jobId}:${identity.turnKey}:0`;
    await host.save({ ...host.document, nodes: host.document.nodes.map(candidate => candidate.id === id
      ? { ...candidate, activeSessionNodeId: sessionNodeId, sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate) });
    await host.step(runId, id, { status: "running", jobId: identity.jobId, turnKey: identity.turnKey, generationRunInput });
    const result = await useStore.getState().startGeneration(prompt, orderedAssets, ratio, provider, prompt,
      undefined, undefined, undefined, visualProfileId, { projectId: host.projectId, threadId: host.run(runId).threadId }, false, generation, identity);
    if (!result.accepted) throw new Error(result.error || "生成未完成");
    const turns = useStore.getState().genJobs[identity.jobId]?.turns ?? [];
    paths = (turns.find(turn => turn.turnKey === identity.turnKey) ?? (turns.length === 1 && !turns[0].turnKey ? turns[0] : undefined))?.images ?? [];
  }
  if (host.isStopped(runId)) return;
  const outputAssetIds = await Promise.all(paths.map(path => api.localAgentFindAssetId(path)));
  if (!outputAssetIds.length || outputAssetIds.some(id => !id)) {
    await host.step(runId, id, { status: "waiting", error: "本次生成产物尚未入库，请稍后继续取回" }); return;
  }
  await host.finish(runId, node, { image: { type: "image", assetIds: [...new Set(outputAssetIds as string[])] } });
}
