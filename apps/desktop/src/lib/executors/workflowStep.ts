import { describeAssetWithNotice } from "../describeNotices";
import { h3OriginalPrompt } from "../canvasWorkflow";
import { resolveDynamicVideoFrame, resolveVideoCardOutputs } from "../workflowVideoFrames";
import { isAudioPath } from "../audioMedia";
import { api } from "../api";
import type { Asset, CanvasNode } from "../types";
import { placeWorkflowOutput } from "../canvasOutputPlacement";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath, resolveVideoOptions, videoInputError } from "../videoGeneration";
import { profileExtractionIssue, profileInputKey, workflowGenerationProvider, workflowProviderIssue } from "../workflowProviderIssue";
import { workflowLoopOutputs, workflowLoopItems, validateLoopItems, validateLoopStart } from "../workflowLoop";
import { emit } from "@tauri-apps/api/event";
import { type WorkflowHostAdapter } from "../workflowHost";
import { existingWorkflowCaption, workflowCaptionSections, workflowDescribeInstruction } from "../workflowDescribe";
import { canStartAnotherAgentRun, canUseAgentRun, understandProvider } from "../entitlement";
import { renderLayerDocument } from "../layerDocument";
import { workflowLayerDecompose } from "../workflowLayerDecompose";
import { readCanvasNote, emptyCanvasCell, canvasTextMinSize } from "../canvasNotes";
import { canvasInputValue } from "../canvasSessionOutputs";
import { canvasContentInput } from "../canvasContentInput";
import { agentResultValue } from "../workflowAgentResult";

import { agentOutputTargets, agentTextWriters, agentWriterValue, routeAgentOutputs } from "../workflowAgentOutputs";
import { filterDisconnectedReferences, generationReferencePreviewOrder, h3RunReferences } from "../canvasWorkflow";
import { WorkflowInputError, WorkflowNodeError } from "../workflowDiagnostics";
import { enqueueCloudAgentRunOperation } from "../cloudAgentRuntime";
import { describeBrandImage } from "../describeBrandImage";
import { canUseComfyVideo, comfyEnvironment, comfyEnvironmentReady, comfyVideoMode, DEFAULT_COMFY_VIDEO, H3_IMAGE_ENDPOINT, h3R2VInputError, type ComfyVideoInput } from "../comfyVideo";
import { h3OptimizationInstruction } from "../h3PromptOptimization";
import {
  compileAgentPrompt, compileGenerationPrompt, generationInputNode, workflowInputProducers, workflowInputValues, H3_VIDEO_AUDIO_PORT, H3_R2V_INPUT_PORTS, WORKFLOW_SKILLS,
  type CanvasWorkflow, type WorkflowKind, type H3ImageGenerationInput, type WorkflowRun, type WorkflowNode, type WorkflowStep, type WorkflowValue
} from "../canvasWorkflow";

import { filterAutomaticMediaValues } from "./automaticMedia";

export type CardStart = { kind: "run" | "optimize"; current: () => boolean; cancel: () => void; release: () => void };

interface WorkflowStepHost {
  readonly projectId: string;
  readonly document: CanvasWorkflow;
  readonly desktop: WorkflowHostAdapter;
  run(runId: string): WorkflowRun;
  step(runId: string, id: string, patch: Partial<WorkflowStep>): Promise<void>;
  progress(runId: string, id: string, detail: string): void;
  finish(runId: string, node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports?: WorkflowNode["outputPorts"]): Promise<void>;
  layoutNodes(): WorkflowNode[];
  save(document: CanvasWorkflow): Promise<void>;
  saveRun(run: WorkflowRun, nodes?: WorkflowNode[]): Promise<void>;
  resolveInputGenerations(runId: string, node: WorkflowNode, values: WorkflowValue[], halted: () => boolean, started?: number, readLatest?: (canvas: CanvasNode[]) => WorkflowValue[]): Promise<boolean>;
  writeContentInput(runId: string, writer: WorkflowNode, value: WorkflowValue, halted: () => boolean): Promise<void>;
  withResource<T>(key: string, work: () => Promise<T>): Promise<T>;
  waitForPoll(runId: string, nodeId: string, started: number, interval: number, halted: () => boolean): Promise<boolean>;
  chatResult(runId: string, node: WorkflowNode, step: WorkflowStep, assets: Asset[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null>;
  localDsResult(runId: string, node: WorkflowNode, step: WorkflowStep, images: string[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null>;
  writeAgentResult(runId: string, node: WorkflowNode, value: WorkflowValue, hasWriters: boolean, halted: () => boolean): Promise<void>;
  writeAgentText(runId: string, node: WorkflowNode, value: WorkflowValue, writers: WorkflowNode[], halted: () => boolean): Promise<void>;
  runVoice(runId: string, node: WorkflowNode, halted: () => boolean, values?: Record<string, WorkflowValue[]>): Promise<void>;
  recoverVideoResult(runId: string, node: WorkflowNode, halted: () => boolean): Promise<void>;
  runComfyPromptOptimization(runId: string, node: WorkflowNode, halted: () => boolean, start?: CardStart): Promise<void>;
  runComfyAutoGeneration(runId: string, node: WorkflowNode, halted: () => boolean, video: ComfyVideoInput, start?: CardStart,
    linkedText?: string, generationRunInput?: WorkflowStep["generationRunInput"]): Promise<void>;
  runComfyAutoImage(runId: string, node: WorkflowNode, halted: () => boolean, image: H3ImageGenerationInput, start?: CardStart): Promise<void>;
  runComfyVideo(runId: string, node: WorkflowNode, halted: () => boolean, input?: ComfyVideoInput, start?: CardStart, generationRunInput?: WorkflowStep["generationRunInput"]): Promise<void>;
  runWorkflowImageSession(runId: string, node: WorkflowNode, halted: () => boolean, input?: {
    prompt: string; rawPrompt: string; references: Asset[]; ratio: string | null; visualProfileId: string | null;
    referenceNodeIds: (string | null)[]; generationRunInput?: WorkflowStep["generationRunInput"];
  }): Promise<void>;
}

interface StepExecution {
  runId: string;
  start?: CardStart;
  halted(): boolean;
  executionStopped(): boolean;
  signal: AbortSignal;
}

export function createWorkflowStepExecutor(host: WorkflowStepHost, { runId, start, halted, executionStopped, signal }: StepExecution) {
  const prepareMediaInputs = async (node: WorkflowNode, inputs: WorkflowNode["inputs"], values: Record<string, WorkflowValue[]>) => {
    for (const [port, items] of Object.entries(values)) for (const [index, value] of items.entries()) {
      const binding = inputs[port]?.[index];
      if (!binding?.nodeId || !binding.videoFrame) continue;
      if (halted()) return;
      items[index] = await resolveDynamicVideoFrame(host.projectId, node, binding, value, halted);
    }
    if (!halted()) await filterAutomaticMediaValues(node, values, host.document.nodes);
  };
  return async (id: string) => {
    const stepUpdate = (patch: Partial<WorkflowStep>) => {
      if (halted()) throw new Error("工作流已停止");
      return host.step(runId, id, patch);
    };
    const progress = (detail: string) => {
      if (!halted()) host.progress(runId, id, detail);
    };
    const finish = (node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports?: WorkflowNode["outputPorts"]) => {
      if (!halted()) return host.finish(runId, node, outputs, ports);
    };
    const accountId = host.run(runId).accountId;
    if (accountId !== undefined && accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
    const step = host.run(runId).steps[id];
    const current = host.document.nodes.find(node => node.id === id)!;
    const storedNode = step.comfyAutoGeneration ? { ...current, prompt: h3OriginalPrompt(current) } : current;
    const node = storedNode.kind === "trigger" ? { ...storedNode, inputs: {} } : storedNode.kind === "comfy-video" ? generationInputNode(storedNode) : storedNode;
    if (step.status === "done" || halted()) return;
    if (node.kind === "voice" && step.voiceRequest) { await host.runVoice(runId, node, halted); return; }
    progress(node.kind === "generation" ? `生成${node.generation?.media === "video" ? "视频" : "图片"}，等待会话结果` : node.kind === "skill" ? "执行技能，等待任务结果或审批" : node.kind === "visual-profile" ? "处理视觉规范" : node.kind === "trigger" ? "触发下游流程" : "读取输入素材");
    if (node.kind === "comfy-video" && step.jobId) { await host.runComfyVideo(runId, node, halted); return; }
    if (node.kind === "comfy-video" && step.comfyAutoGeneration?.input) {
      await host.runComfyAutoGeneration(runId, node, halted, step.comfyAutoGeneration.input, start); return;
    }
    if (node.kind === "generation" && step.comfyAutoGeneration?.imageInput) {
      await host.runComfyAutoImage(runId, node, halted, step.comfyAutoGeneration.imageInput, start); return;
    }
    if (step.comfyOptimization) { await host.runComfyPromptOptimization(runId, node, halted, start); return; }
    if (node.kind === "generation" && node.generation?.media === "video" && step.jobId) {
      await host.recoverVideoResult(runId, node, halted); return;
    }
    const frozenChat = node.kind === "agent" && step.chatInput ? step.agentInput : undefined;
    const hasCells = !frozenChat && Object.values(node.inputs).flat().some(input => input.canvasNodeId);
    const cellTexts = host.run(runId).cellTexts;
    let canvas = hasCells || node.kind === "loop" ? await api.projectCanvasGet(host.projectId) : null;
    if (halted()) return;
    let refreshedLatest = false;
    const readCell = (nodeId: string, cellId: string) => {
      const frozenSource = host.document.nodes.some(node => node.textSource === nodeId && host.run(runId).order.includes(node.id));
      const producedThisRun = !frozenSource && workflowInputProducers(host.document.nodes, { canvasNodeId: nodeId, cellId }).some(id => host.run(runId).order.includes(id));
      const frozen = host.run(runId).cellValues?.[JSON.stringify([nodeId, cellId])] ?? cellTexts?.[JSON.stringify([nodeId, cellId])];
      if (cellTexts && !producedThisRun && frozen !== undefined && !(refreshedLatest && ["*latest", "*latest-image"].includes(cellId))) return frozen;
      const source = canvas?.nodes.find(candidate => candidate.id === nodeId && candidate.hiddenAt == null);
      return source ? canvasInputValue(source, cellId, canvas!.nodes) : undefined;
    };
    // Latest-row sockets remain dynamic while waiting: a newly appended row
    // replaces the previous candidate for both text and image consumers.
    const connectedNode = generationInputNode(node, host.document.nodes);
    const latestInputs = Object.values(connectedNode.inputs).flat().filter(input => input.canvasNodeId && ["*latest", "*latest-image"].includes(input.cellId ?? ""));
    const latestWaitStarted = Date.now();
    while (!frozenChat && latestInputs.length && !(node.kind === "text" && node.textTarget?.image) && !(node.kind === "loop" && host.run(runId).loop?.items)) {
      const pending = latestInputs.flatMap(input => {
        const value: string | WorkflowValue | undefined = readCell(input.canvasNodeId!, input.cellId!);
        return value && typeof value !== "string" && value.nodeIds?.length ? [value] : [];
      });
      if (!pending.length) break;
      if (!await host.resolveInputGenerations(runId, node, pending, halted, latestWaitStarted, current => latestInputs.flatMap(input => {
        const source = current.find(card => card.id === input.canvasNodeId && card.hiddenAt == null);
        const value: WorkflowValue | undefined = source && canvasInputValue(source, input.cellId!, current);
        return value?.nodeIds?.length ? [value] : [];
      }))) return;
      if (accountId !== undefined && accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
      canvas = await api.projectCanvasGet(host.projectId);
      if (halted()) return;
      refreshedLatest = true;
    }
    if (node.kind === "loop") {
      const run = host.run(runId), loop = run.loop;
      if (!loop || loop.nodeId !== id) throw new WorkflowNodeError("请从循环卡片启动完整流程", node);
      let sourceItems = loop.items;
      if (!sourceItems && node.loopMode !== "rows" && node.loopMode !== "count") {
        const values = structuredClone(workflowInputValues(host.document.nodes, node, readCell));
        const pending = values.image.filter(value => value.nodeIds?.length);
        if (pending.length && !await host.resolveInputGenerations(runId, node, pending, halted)) return;
      if (pending.length && accountId !== undefined && accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
        await prepareMediaInputs(node, node.inputs, values);
        if (halted()) return;
        await resolveVideoCardOutputs(node, values, canvas?.nodes ?? [], host.projectId, halted);
        if (halted()) return;
        sourceItems = validateLoopItems(values.image.flatMap(value => value.assetIds ?? []).map(assetId => ({ text: "", assetIds: [assetId] })), node);
      }
      const items = validateLoopStart(sourceItems ?? workflowLoopItems(node, host.document.nodes, canvas?.nodes ?? [], readCell), loop.index, node);
      const current = host.run(runId);
      await host.saveRun({ ...current, loop: { ...loop, items }, steps: { ...current.steps, [id]: { status: "done", detail: `第 ${loop.index + 1} / ${items.length} 项` } } },
        host.document.nodes.map(candidate => candidate.id === id ? { ...candidate, outputs: workflowLoopOutputs(items[loop.index], loop.index) } : candidate));
      return;
    }
    if (node.kind === "director3d") {
      if (!node.directorVideoId) throw new Error("3D 导演台已下架，此卡片没有已导出的视频，请改用视频素材");
      await finish(node, {image:{type:"image",assetIds:[node.directorVideoId]}});
      return;
    }
    const directedValue = agentWriterValue(node, host.document.nodes);
    if (directedValue === null) {
      await stepUpdate({ detail: "本次未指定此输出位置，保留原内容" });
      await finish(node, {});
      return;
    }
    const values: Record<string, WorkflowValue[]> = frozenChat ? {} : structuredClone(directedValue ? { [directedValue.type]: [directedValue] } : workflowInputValues(host.document.nodes, connectedNode, readCell));
    {
      const pending = Object.entries(values).flatMap(([port, items]) => items.filter((value, index) =>
        value.nodeIds?.length && value.type === "image" &&
        (node.kind !== "text" || !node.textTarget?.image || connectedNode.inputs[port]?.[index]?.videoFrame)));
      if (pending.length && !await host.resolveInputGenerations(runId, node, pending, halted)) return;
      if (pending.length && accountId !== undefined && accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
    }
    // Compare the editor's references, before media conversion replaces sources with frame assets.
    const localVideoMode = node.kind === "comfy-video" ? comfyVideoMode(node.comfyVideo) : undefined;
    let generationRunInput = node.kind === "generation" ? { prompt: node.prompt, references: [generationReferencePreviewOrder(connectedNode, values, host.document.nodes)] }
      : localVideoMode ? { prompt: node.prompt, references: h3RunReferences(filterDisconnectedReferences(connectedNode.inputs, values), localVideoMode) }
      : undefined;
    const inputNode: WorkflowNode = step.localAgentSkill === "hyperframes" ? { ...node, skill: "hyperframes", agentTransport: "codex-cli" } : node;
    const r2vImagePort = H3_R2V_INPUT_PORTS.image;
    const frameSources = localVideoMode === "r2v" ? connectedNode.inputs[r2vImagePort]?.map((input, index) =>
      input.nodeId && input.videoFrame ? values[r2vImagePort]?.[index] : undefined) : undefined;
    await prepareMediaInputs(inputNode, connectedNode.inputs, values);
    if (halted()) return;
    if ((node.kind === "generation" || node.kind === "comfy-video") && Object.values(connectedNode.inputs).some(port => port.some(input => input.excludedAssetIds?.length))) {
      Object.assign(values, filterDisconnectedReferences(connectedNode.inputs, values));
    }
    if (localVideoMode === "r2v") generationRunInput = { prompt: node.prompt, references: h3RunReferences({ ...values,
      [r2vImagePort]: (values[r2vImagePort] ?? []).map((value, index) => value.assetIds?.length ? frameSources?.[index] ?? value : value),
    }, localVideoMode) };
    if (node.kind === "voice") { await host.runVoice(runId, node, halted, values); return; }
    if (node.kind === "instruction") {
      const count = (values.image ?? []).flatMap(value => value.assetIds ?? []).length;
      if (node.action === "describe" ? count < 1 : count !== 1) throw new Error("指令卡片的输入图片数量不符合要求");
    }
    await resolveVideoCardOutputs(inputNode, values, canvas?.nodes ?? [], host.projectId, halted, host.document.nodes);
    if (halted()) return;
    const generated = node.kind === "generation" ? compileGenerationPrompt(node, values, host.document.nodes, !!step.comfyAutoGeneration) : null;
    const outputTargets = node.kind === "agent" ? step.agentOutputTargets ?? agentOutputTargets(node, host.document.nodes) : [];
    const agentInput = node.kind === "agent" ? frozenChat ?? compileAgentPrompt(node, values, outputTargets) : null;
    const referenceImages = localVideoMode === "r2v" ? (values[H3_R2V_INPUT_PORTS.image] ?? []).flatMap(value => value.assetIds ?? []) : undefined;
    const assetIds = generated?.assetIds ?? step.agentInput?.assetIds ?? agentInput?.assetIds ?? [...new Set(referenceImages ?? [...(values.image ?? []), ...(values.text ?? []), ...(values["first-frame"] ?? []), ...(values["last-frame"] ?? [])].flatMap(value => value.assetIds ?? []))];
    const assets = assetIds.length ? await api.getAssetsByIds(assetIds) : [];
    const video = node.kind === "generation" && node.generation?.media === "video";
    const acceptsVideo = video || node.kind === "agent" || node.kind === "text" && node.textTarget?.image;
    if (assets.length !== assetIds.length || assets.some(asset => !asset.store_path || !acceptsVideo && (asset.duration || isVideoPath(asset.store_path)
      || (node.kind === "comfy-video" || !!step.comfyAutoGeneration) && isAudioPath(asset.store_path)))) throw new Error("输入素材已丢失或当前卡片仅支持静态图片，请重新选择");
    const orderedAssets = assetIds.map(id => assets.find(asset => asset.id === id)!);
    const linkedText = generated ? "" : (values.text ?? []).map(value => value.text?.replace(/@图片\d+/g, token => {
      const ref = value.imageRefs?.find(ref => ref.token === token);
      const index = ref ? (referenceImages ?? assetIds).indexOf(ref.asset_id) : -1;
      return index < 0 ? token : referenceImages ? `<Picture ${index + 1}>` : `@图片${index + 1}`;
    })).filter(Boolean).join("\n\n");
    const prompt = generated?.prompt ?? [linkedText, node.prompt].filter(Boolean).join("\n\n").trim();
    const visualProfileId = values["visual-profile"]?.[0]?.profileId ?? null;
    let agentVisualProfile = step.agentInput?.visualProfile ?? null;
    if (visualProfileId && !(node.kind === "agent" && step.agentInput)) {
      const profile = await api.visualProfileGet(visualProfileId);
      if (halted()) return;
      if (profile.status !== "confirmed" || profile.version !== values["visual-profile"][0].version) throw new Error("连接的视觉规范已删除或版本不匹配，请重新选择");
      if (node.kind === "agent") agentVisualProfile = profile;
    }
    const runSignal = async () => {
      await finish(node, {});
    };
    const runText = async () => {
      const textValue = values.text?.[0];
      const value: WorkflowValue = textValue ?? { type: "image", assetIds, nodeIds: [...new Set((values.image ?? []).flatMap(value => value.nodeIds ?? []))] };
      await stepUpdate({ status: "running", detail: textValue ? "写入文本单元格" : "写入图片单元格" });
      // An explicitly empty classification clears that fixed destination, instead of
      // leaving a previous product/copy image visible as if it belonged to this run.
      if (!node.textTarget?.append && value.nodeIds?.length && value.nodeIds.length + (value.assetIds?.length ?? 0) > 1) throw new Error("多个生成结果请连接内容卡行或列图片输入，每个任务占一个单元格");
      const remaining = value.type === "image" ? { ...value, nodeIds: value.nodeIds?.filter(id => !step.agentSessionDeliveries?.[id]?.done) } : value;
      if (remaining.type !== "image" || remaining.assetIds?.length || remaining.nodeIds?.length || !value.nodeIds?.length) {
        await host.writeContentInput(runId, node, directedValue?.type === "image" && !directedValue.assetIds?.length && !directedValue.nodeIds?.length ? { type: "text", text: "" } : remaining, halted);
      }
      if (halted()) return;
      await finish(node, { [value.type]: value });
      await emit("creative://changed", { projectId: host.projectId });
    };
    const runProfile = async () => {
      const inputKey = profileInputKey(assetIds, prompt);
      let profileId = node.profileId || step.profileId || (node.profileCache?.inputKey === inputKey ? node.profileCache.profileId : undefined);
      if (!profileId) {
        if (step.status !== "pending") throw new Error("上次提炼状态未知，请检查已有规范后选择版本，或停止后重新提炼");
        const issue = profileExtractionIssue(host.desktop.getState());
        if (issue) throw new WorkflowNodeError(issue.message, node);
        if (prompt.length > 4000) throw new Error("视觉要求不能超过 4000 字");
        const missing = await api.visualProfileInputPreview(assetIds, prompt);
        if (halted()) return;
        await stepUpdate({ status: "running" });
        for (const assetId of missing) {
          if (halted()) return;
          if (host.run(runId).accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
          await describeBrandImage(assetId, signal);
        }
        if (halted()) return;
        if (host.run(runId).accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
        const profile = await api.visualProfileExtractInputs(`${host.projectId}:${node.id}`, node.profileName?.trim() || "画板视觉规范", assetIds, prompt);
        if (halted()) return;
        profileId = profile.id;
        await host.save({ ...host.document, nodes: host.document.nodes.map(n => n.id === id ? { ...n, profileCache: { inputKey, profileId: profile.id } } : n) });
        if (halted()) return;
      }
      const profile = await api.visualProfileGet(profileId);
      if (halted()) return;
      if (profile.status === "archived") throw new Error("此视觉规范已删除，请停止后选择其他版本");
      if (profile.status !== "confirmed") {
        await stepUpdate({ status: "waiting", profileId, error: "请查看并保存规范，再继续下游" });
        if (host.desktop.getState().activeProjectId === host.projectId) host.desktop.getState().openVisualProfile({ id: profile.folderId, name: profile.name, profileId });
        return;
      }
      await finish(node, { "visual-profile": { type: "visual-profile", profileId, version: profile.version, summary: profile.summary } });
    };
    const reusePrompt = async () => {
      const history = await api.generationHistory(assetIds[0], null);
      // Use the compiled prompt so dimension chips cannot leak unresolved tokens downstream.
      const text = history.turns[0]?.prompt;
      if (!text) throw new Error("这张图片没有可复用的生成提示词");
      await finish(node, { text: { type: "text", text }, image: { type: "image", assetIds: history.references.map(asset => asset.id) } });
    };
    const describeMaterials = async () => {
      if (step.status !== "pending") throw new Error("上次反推的结果未知。请检查该图反推记录，停止流程后显式重试。");
      const state = host.desktop.getState();
      const instruction = workflowDescribeInstruction(node);
      const cached = assetIds.map(assetId => node.overwriteDescribe ? [] : existingWorkflowCaption(node, assetId, instruction));
      if (halted()) return;
      const provider = state.defaultUnderstandProvider === "auto" ? understandProvider(state.cloudEntitlement) : state.defaultUnderstandProvider;
      if (!provider && cached.some(parts => !parts.length)) throw new Error("当前没有可用的反推引擎");
      const sections: Array<{ title: string; body: string }> = [];
      const rows: Array<{ assetId: string; name: string; prompt: string }> = [];
      const jobs = assetIds.map((_, index) => cached[index].length ? null : `workflow-describe-${crypto.randomUUID()}`);
      const describeJobIds = jobs.filter((job): job is string => !!job);
      const reused = cached.filter(parts => parts.length).length;
      await stepUpdate({ status: "running", describeJobIds, detail: `复用 ${reused} 张 · 反推 ${describeJobIds.length} 张` });
      let completed = 0, failed = false;
      let firstError: unknown;
      const pending = new Set(describeJobIds);
      // Settle all started requests before unlocking the card; an error cancels only this batch.
      const results = await Promise.allSettled(assetIds.map(async (assetId, index) => {
        try {
          if (cached[index].length) return cached[index];
          const analysisId = await describeAssetWithNotice(assetId, orderedAssets[index].name, instruction, provider!, jobs[index]!);
          const analysis = (await api.listAnalysesByAsset(assetId)).find(item => item.id === analysisId);
          if (halted()) return [];
          const parts = analysis ? workflowCaptionSections(analysis.payload) : [];
          if (!parts?.length) throw new Error(`第 ${index + 1} 张图片反推未返回可用维度`);
          completed++;
          if (!failed) progress(`复用 ${reused} 张 · 并行反推 ${describeJobIds.length} 张 · 已完成 ${completed}/${describeJobIds.length}`);
          return parts;
        } catch (error) {
          if (!failed) {
            failed = true; firstError = error;
            progress(`反推失败，正在停止本批次剩余任务`);
            await Promise.allSettled([...pending].filter(jobId => jobId !== jobs[index]).map(jobId => api.cancelCodexDescribe(jobId)));
          }
          throw error;
        } finally { if (jobs[index]) pending.delete(jobs[index]!); }
      }));
      if (halted()) return;
      if (failed) throw firstError;
      // Keep this card's successful batch independently of image history and transient outputs.
      const describeCache = { instruction, results: assetIds.map((assetId, index) => {
        const result = results[index];
        if (result.status !== "fulfilled") throw result.reason;
        return { assetId, sections: result.value };
      }) };
      await host.save({ ...host.document, nodes: host.document.nodes.map(candidate => candidate.id === id ? { ...candidate, describeCache } : candidate) });
      if (halted()) return;
      for (const [index, assetId] of assetIds.entries()) {
        const result = results[index];
        if (result.status !== "fulfilled") throw result.reason;
        const parts = result.value;
        rows.push({ assetId, name: orderedAssets[index].name, prompt: parts.map(part => `${part.title}：${part.body}`).join("\n\n") });
        for (const part of parts) {
          const body = assetIds.length > 1 ? `图片 ${index + 1}：${part.body}` : part.body;
          const existing = sections.find(section => section.title === part.title);
          if (existing) existing.body += `\n\n${body}`; else sections.push({ title: part.title, body });
        }
      }
      const promptText = sections.map(section => `${section.title}：${section.body}`).join("\n\n");
      await host.withResource("canvas", async () => {
        if (halted()) return;
        progress(`已反推 ${rows.length} 张图片，正在生成素材 / 提示词表格`);
        const tableId = `workflow-describe:${runId}:${id}`;
        const cell = (text: string, key: string, bold = false) => ({ id: key, text, bold, italic: false, align: "left" });
        const cells = [[cell("素材", "heading-asset", true), cell("提示词", "heading-prompt", true)],
          ...rows.map(row => [{ ...cell("@图片1", `${row.assetId}-asset`), content_type: "image", image_refs: [{ asset_id: row.assetId, token: "@图片1" }] }, cell(row.prompt, `${row.assetId}-prompt`)])];
        const canvas = await api.projectCanvasGet(host.projectId);
        if (halted()) return;
        const writers = host.document.nodes.filter(candidate => candidate.textTarget && candidate.inputs.text?.some(input => input.nodeId === id && input.portId === "text"));
        const width = 640, height = 40 + 100 * cells.length;
        const { x, y } = placeWorkflowOutput(canvas, host.layoutNodes(), node, { width, height }, new Set([tableId]));
        const previousTables = canvas.nodes.filter(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
        const payload = { schema_version: 1, note_type: "text", title: `反推结果 · ${rows.length} 张素材`, cells, text: cells.map(row => row.map(item => item.text).join("\t")).join("\n"), member_ids: [], column_widths: [1, 3], row_heights: [0.45, ...rows.map(() => 1)] };
        if (previousTables.length) {
          for (const table of previousTables) {
            if (halted()) return;
            const previous = readCanvasNote(table);
            const updatedCells = cells.map((row, r) => row.map((cell, c) => ({ ...cell, id: previous.cells[r]?.[c]?.id ?? cell.id })));
            await api.projectCanvasNoteUpdate(table.id, JSON.stringify({ ...payload, cells: updatedCells }));
          }
        } else if (!writers.length) {
          await api.projectCanvasNodeCreate({ id: tableId, projectId: host.projectId, threadId: host.run(runId).threadId, kind: "note", assetId: null, role: null,
            payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
          if (halted()) return;
          await host.save({ ...host.document, nodes: host.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: [tableId] } : item) });
        }
        if (!halted()) await emit("creative://changed", { projectId: host.projectId, threadId: host.run(runId).threadId, jobId: runId, turnKey: tableId, status: "done" });
      });
      if (halted()) return;
      await finish(node, { text: { type: "text", text: promptText } }, []);
    };
    const decomposeMaterial = async () => {
      await host.withResource(`layer:${assetIds[0]}`, async () => {
        if (halted()) return;
        const key = step.layerRequestKey ?? `layers-${crypto.randomUUID()}`;
        const create = step.status === "pending" && !step.layerRequestKey;
        if (!create && !step.layerRequestKey) throw new Error("原分层步骤没有拆分任务，请重新运行卡片");
        await stepUpdate({ status: "running", assetId: assetIds[0], layerRequestKey: key });
        const started = Date.now();
        const document = await workflowLayerDecompose(assetIds[0], orderedAssets[0].store_path!, "", key, create, halted,
          () => host.waitForPoll(runId, id, started, 2000, halted), progress);
        if (!document || halted()) return;
        const productIds: string[] = [];
        for (const [index, layer] of document.layers.entries()) {
          if (halted()) return;
          progress(`导出第 ${index + 1}/${document.layers.length} 层：${layer.name}`);
          const doc = { ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === layer.id })) };
          const rendered = await renderLayerDocument(doc);
          if (halted()) return;
          const image = await api.layerExport(assetIds[0], doc, rendered, host.projectId, true);
          productIds.push(image.id);
        }
        if (halted()) return;
        const products = [...new Set(productIds)];
        await host.withResource("canvas", async () => {
          if (halted()) return;
          const canvas = await api.projectCanvasGet(host.projectId);
          if (halted()) return;
          const writers = host.document.nodes.filter(candidate => candidate.textTarget?.image && candidate.inputs.image?.some(input => input.nodeId === id && input.portId === "image"));
          let resultId: string | undefined;
          if (!writers.length) {
            const previousTable = canvas.nodes.find(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
            resultId = previousTable?.id ?? `workflow-layers:${runId}:${id}`;
            const previous = previousTable && readCanvasNote(previousTable);
            const cells = previous?.cells ?? [[{ ...emptyCanvasCell(), id: crypto.randomUUID() }]];
            const slots = cells.flat().filter(cell => cell.content_type === "image").map(cell => cell.id!);
            const payload = canvasContentInput({ ...previous, schema_version: 1, note_type: "text", title: previous?.title ?? "拆分产物", cells, text: "", member_ids: [] },
              { nodeId: resultId, cellId: cells[0][0].id!, append: true, ...(slots.length > 1 ? { cellIds: slots } : {}) }, { type: "image", assetIds: products }).note;
            const minimum = canvasTextMinSize(payload.cells);
            if (halted()) return;
            if (previousTable) {
              await api.projectCanvasNoteUpdate(resultId, JSON.stringify(payload));
              if (halted()) return;
              if (previousTable.width < minimum.width || previousTable.height < minimum.height) await api.projectCanvasNodeUpdate(resultId, {
                x: previousTable.x, y: previousTable.y, width: Math.max(previousTable.width, minimum.width), height: Math.max(previousTable.height, minimum.height), zIndex: previousTable.zIndex, positionLocked: previousTable.positionLocked,
              });
            }
            else {
              const width = Math.max(440, minimum.width), height = Math.max(260, minimum.height);
              const { x, y } = placeWorkflowOutput(canvas, host.layoutNodes(), node, { width, height });
              await api.projectCanvasNodeCreate({ id: resultId, projectId: host.projectId, threadId: host.run(runId).threadId, kind: "note", assetId: null, role: null,
                payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
            }
          }
          if (halted()) return;
          await host.save({ ...host.document, nodes: host.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: resultId ? [resultId] : [], resultGroupId: undefined } : item) });
          if (halted()) return;
          const reveal = !host.document.nodes.some(item => Object.values(item.inputs).flat().some(input => workflowInputProducers(host.document.nodes, input).includes(id)));
          await emit("creative://changed", { projectId: host.projectId, threadId: host.run(runId).threadId, jobId: runId, turnKey: resultId ?? id, status: "done", ...(reveal && resultId ? { revealProductNodeId: resultId } : {}) });
        });
        if (halted()) return;
        await finish(node, { image: { type: "image", assetIds: products } }, []);
      });
    };
    const runAgent = async () => {
      const snapshot = step.agentInput ?? { ...agentInput!, visualProfile: agentVisualProfile };
      if (!step.agentInput) await stepUpdate({ agentInput: snapshot });
      if (!snapshot.prompt.trim()) throw new WorkflowNodeError("Agent 要求不能为空", node);
      if (outputTargets.length && !step.agentOutputTargets) await stepUpdate({ agentOutputTargets: outputTargets });
      let outputs: Record<string, WorkflowValue>;
      if (!step.localDsRequestId && !step.agentRunId) {
        const result = await host.chatResult(runId, node, step, orderedAssets, halted);
        if (!result) return;
        outputs = result;
      } else if (step.localDsRequestId) {
        const result = await host.localDsResult(runId, node, step, orderedAssets.map(asset => asset.store_path!), halted);
        if (!result) return;
        outputs = result;
      } else {
      const agentRunId = step.agentRunId!; // Legacy accepted Cloud runs are read only; new turns use localChat.
      let result;
      const pollStarted = Date.now();
      while (!halted()) {
        const current = await api.cloudAgentGet(agentRunId);
        if (halted()) return;
        host.desktop.getState().openCloudAgentRun(current, { navigate: false });
        if (["failed", "cancelled"].includes(current.status)) {
          const code = current.snapshot.run.error_code;
          const message = code === "unified_agent_text_result_invalid" ? "模型没有返回有效的完整改写文本" : code === "unified_agent_input_invalid" ? "云端未识别文本改写输入，请检查 Worker 版本" : current.snapshot.run.safe_message || "文本改写未完成";
          throw new Error(`${message}（Cloud DSH 任务 ${agentRunId}${code ? `，${code}` : ""}）`);
        }
        if (current.status === "succeeded") { result = current; break; }
        if (current.status.startsWith("awaiting_")) throw new Error("云端未按文本改写模式执行，请检查 Cloud DSH 服务版本");
        progress(current.status === "queued" ? "Cloud DSH 文本改写排队中" : "Cloud DSH 正在修改文本");
        if (!await host.waitForPoll(runId, id, pollStarted, 2000, halted)) return;
      }
      if (halted() || !result) return;
      const payload = result.snapshot.events.find(event => event.type === "text.result")?.display_payload;
      if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim()) throw new Error("Cloud DSH 未返回有效的改写文本，请检查任务结果或服务版本");
      outputs = { text: agentResultValue(payload.text) };
      }
      outputs = routeAgentOutputs(outputs, outputTargets, orderedAssets.map(asset => asset.id));
      const writers = agentTextWriters(node, host.document.nodes);
      if (!outputTargets.length) {
        // A wired content card is the result's home: write it now so an early stop still
        // leaves the text on the board, and never add a second "Agent 结果" card beside it.
        if (writers.length) await host.writeAgentText(runId, node, outputs.text ?? { type: "text", text: "" }, writers, halted);
        else await host.writeAgentResult(runId, node, outputs.text ?? { type: "text", text: "" }, false, halted);
      }
      if (halted()) return;
      await finish(node, outputs);
      await emit("creative://changed", { projectId: host.projectId });
    };
    const runH3 = async () => {
      const account = host.desktop.getState();
      if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 视频需要有效的 Pro／Studio 权益或测试账号资格");
      const first = (values["first-frame"] ?? []).flatMap(value => value.assetIds ?? []);
      const last = (values["last-frame"] ?? []).flatMap(value => value.assetIds ?? []);
      const audioBindings = localVideoMode === "r2v" ? [] : node.inputs[H3_VIDEO_AUDIO_PORT] ?? [];
      const audio = (values[H3_VIDEO_AUDIO_PORT] ?? []).flatMap(value => value.assetIds ?? []);
      if (audioBindings.length && (audioBindings.length !== 1 || audio.length !== 1)) {
        throw new WorkflowInputError("请连接一段可用的本地录音", node, audioBindings[0]);
      }
      const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
      const mode = comfyVideoMode(options);
      const referenceVideos = mode === "r2v" ? (values[H3_R2V_INPUT_PORTS.video] ?? []).flatMap(value => value.assetIds ?? []) : undefined;
      const referenceAudios = mode === "r2v" ? (values[H3_R2V_INPUT_PORTS.audio] ?? []).flatMap(value => value.assetIds ?? []) : undefined;
      const referenceError = mode === "r2v" && h3R2VInputError(referenceImages?.length ?? 0, referenceVideos?.length ?? 0, referenceAudios?.length ?? 0);
      if (referenceError) throw new WorkflowNodeError(referenceError, node);
      if (mode === "frames" && (first.length !== 1 || last.length > 1)) throw new Error("请连接一张首帧，尾帧最多一张");
      if (mode === "reference" && first.length !== 1) throw new Error("单图模式需要连接一张参考图");
      const localPrompt = mode === "reference" && audio.length && !prompt.includes("<Audio 1>") ? `${prompt}\n<Audio 1>` : prompt;
      if (!prompt || localPrompt.length > 16000) throw new Error("请填写 1–16000 字提示词");
      if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 15) throw new Error("视频时长需为 1–15 秒");
      const input: ComfyVideoInput = { ...options, firstFrame: mode === "text" || mode === "r2v" ? "" : first[0], lastFrame: mode === "frames" ? last[0] : undefined, prompt: localPrompt,
        ...(mode === "r2v" ? { referenceImages, referenceVideos, referenceAudios } : audio.length ? { audioAssetId: audio[0] } : {}) };
      if (step.comfyAutoGeneration) await host.runComfyAutoGeneration(runId, node, halted, input, start, linkedText, generationRunInput);
      else await host.runComfyVideo(runId, node, halted, input, start, generationRunInput);
    };
    const runGeneration = async () => {
      const generation = video ? { ...node.generation, media: "video" as const, videoOptions: resolveVideoOptions(node.generation?.videoOptions ?? DEFAULT_VIDEO_OPTIONS, orderedAssets) } : undefined;
      const provider = workflowGenerationProvider(node);
      if (!step.jobId) {
        const issue = workflowProviderIssue(node, host.desktop.getState());
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
            await stepUpdate({ generationRunInput, comfyAutoGeneration: { imageInput },
              comfyOptimization: { input, instruction: h3OptimizationInstruction(input), createdAt: Date.now(),
                inputBindings: JSON.stringify([node.inputs, node.promptReferences]) } });
            if (!halted()) await host.runComfyAutoImage(runId, node, halted, imageInput, start);
          } else {
            await host.runWorkflowImageSession(runId, node, halted, { prompt, rawPrompt: prompt, references: orderedAssets, ratio, visualProfileId, referenceNodeIds, generationRunInput });
          }
        } else {
          await host.runWorkflowImageSession(runId, node, halted);
        }
        return;
      }
      let paths: string[] = [];
      if (step.jobId) {
        const previous = (await api.recentGenSessions(500)).find(job => job.id === step.jobId);
        if (!previous || previous.status !== "done") {
          if (previous?.status === "failed") throw new Error(previous.error || "生成失败");
          await stepUpdate({ status: "waiting", error: "原任务尚未完成，请稍后继续取回" }); return;
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
        await stepUpdate({ status: "running", jobId: identity.jobId, turnKey: identity.turnKey, generationRunInput });
        const result = await host.desktop.getState().startGeneration(prompt, orderedAssets, ratio, provider, prompt,
          undefined, undefined, undefined, visualProfileId, { projectId: host.projectId, threadId: host.run(runId).threadId }, false, generation, identity);
        if (!result.accepted) throw new Error(result.error || "生成未完成");
        const turns = host.desktop.getState().genJobs[identity.jobId]?.turns ?? [];
        paths = (turns.find(turn => turn.turnKey === identity.turnKey) ?? (turns.length === 1 && !turns[0].turnKey ? turns[0] : undefined))?.images ?? [];
      }
      if (halted()) return;
      const outputAssetIds = await Promise.all(paths.map(path => api.localAgentFindAssetId(path)));
      if (!outputAssetIds.length || outputAssetIds.some(id => !id)) {
        await stepUpdate({ status: "waiting", error: "本次生成产物尚未入库，请稍后继续取回" }); return;
      }
      await finish(node, { image: { type: "image", assetIds: [...new Set(outputAssetIds as string[])] } });
    };
    const runSkill = async () => {
      if (!step.agentRunId) {
        if (step.status !== "pending") throw new Error("技能提交状态未知，请先检查 Agent 任务记录");
        const skill = WORKFLOW_SKILLS.find(skill => skill.id === node.skill);
        if (!skill) throw new Error("技能不可用");
        const account = host.desktop.getState();
        if (!account.cloudAuth?.logged_in || !account.cloudEntitlement?.is_test_account
          || account.cloudEntitlement.user_id !== account.cloudAuth.user_id
          || !canUseAgentRun(account.cloudEntitlement, "bowerbird-unified-agent")) throw new Error("当前账号尚未开放此技能，请使用已获授权的测试账号");
        const active = Object.values(account.cloudAgentRuns).filter(run => !["succeeded", "failed", "cancelled"].includes(run.status)).length;
        if (!canStartAnotherAgentRun(account.cloudEntitlement, active, "bowerbird-unified-agent")) throw new Error("技能并发已满，请等待当前任务结束");
        await stepUpdate({ status: "running" });
        const run = await api.cloudAgentStart({ intentPrompt: `${skill.instruction}\n\n${prompt}`, references: assetIds.map(assetId => ({ assetId })),
          projectId: host.projectId, threadId: host.run(runId).threadId, visualProfileId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh", ratio: node.ratio });
        if (halted()) { if (executionStopped()) await api.cloudAgentCancel(run.runId); return; }
        await stepUpdate({ status: "waiting", agentRunId: run.runId });
        host.desktop.getState().openCloudAgentRun(run, { navigate: false });
        return;
      }
      const run = await api.cloudAgentGet(step.agentRunId);
      if (halted()) return;
      host.desktop.getState().openCloudAgentRun(run, { navigate: false });
      if (["failed", "cancelled"].includes(run.status)) throw new Error(run.snapshot.run.safe_message || "技能执行未完成");
      if (run.status !== "succeeded") { await stepUpdate({ status: "waiting" }); return; }
      const images = await enqueueCloudAgentRunOperation(run.runId, () => api.cloudAgentIngestArtifacts(run.runId));
      if (halted()) return;
      if (!images.length) throw new Error("技能未交付可用图片");
      await finish(node, { image: { type: "image", assetIds: images.map(image => image.id) } });
    };
    const instructions = { reuse: reusePrompt, describe: describeMaterials, layers: decomposeMaterial };
    const executors: Partial<Record<WorkflowKind, () => Promise<void>>> = {
      trigger: runSignal, text: runText, instruction: () => (instructions[node.action] ?? runSkill)(),
      "visual-profile": runProfile, agent: runAgent, "comfy-video": runH3, generation: runGeneration, skill: runSkill,
    };
    const execute = node.textSource ? runSignal : executors[node.kind] ?? runSkill;
    await execute();
  };
}
