import { emit } from "@tauri-apps/api/event";
import type { WorkflowHostAdapter } from "./workflowHost";
import { api } from "./api";
import { isAudioPath } from "./audioMedia";
import { H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT, workflowInputValues, type CanvasWorkflow,
  type H3ImageGenerationInput, type WorkflowNode, type WorkflowRun, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";
import type { compileAgentPrompt, compileGenerationPrompt } from "./canvasWorkflow";
import { canUseComfyVideo, comfyEnvironment, comfyEnvironmentReady, comfyVideo, comfyVideoElapsed, comfyVideoMode,
  DEFAULT_COMFY_VIDEO, H3_IMAGE_ENDPOINT, h3R2VInputError, type ComfyVideoInput, type ComfyVideoStatus, type ComfyVideoMode } from "./comfyVideo";
import { h3OptimizationInstruction } from "./h3PromptOptimization";
import type { Asset, CanvasNode, ProjectCanvasSnapshot } from "./types";
import { voiceApi } from "./voice";
import { defaultVoiceSample, voiceCardClip, voiceCardPreviewKey, type VoiceCardRequest } from "./voiceCard";
import { DEFAULT_VIDEO_OPTIONS, resolveVideoOptions, videoInputError } from "./videoGeneration";
import { agentResultValue } from "./workflowAgentResult";
import { agentTextWriters, routeAgentOutputs, type AgentOutputTarget } from "./workflowAgentOutputs";
import { WorkflowInputError, WorkflowNodeError } from "./workflowDiagnostics";
import { workflowLoopItems, workflowLoopOutputs, validateLoopItems, validateLoopStart } from "./workflowLoop";
import { workflowGenerationProvider, workflowProviderIssue } from "./workflowProviderIssue";
import { resolveVideoCardOutputs } from "./workflowVideoFrames";

type Halted = () => boolean;
type Inputs = Record<string, WorkflowValue[]>;

export type WorkflowCardStart = { kind: "run" | "optimize"; signal: AbortSignal; current: () => boolean; cancel: () => void; release: () => void };
type CardRun = { runId: string; node: WorkflowNode; halted: Halted };
export type WorkflowImageSessionInput = {
  prompt: string; rawPrompt: string; references: Asset[]; ratio: string | null; visualProfileId: string | null;
  referenceNodeIds: (string | null)[]; generationRunInput?: WorkflowStep["generationRunInput"];
};

/** The controller retains ownership of workflow writes, locks and cancellation. */
export interface WorkflowCardExecution {
  readonly projectId: string;
  readonly desktop: WorkflowHostAdapter;
  readonly document: CanvasWorkflow;
  run(id: string): WorkflowRun;
  save(document: CanvasWorkflow): Promise<void>;
  saveRun(run: WorkflowRun, nodes: WorkflowNode[]): Promise<void>;
  step(runId: string, nodeId: string, patch: Partial<WorkflowStep>): Promise<void>;
  progress(runId: string, nodeId: string, detail: string, videoProgress?: import("./comfyVideo").ComfyVideoProgress): void;
  finish(runId: string, node: WorkflowNode, outputs: Record<string, WorkflowValue>, ports?: WorkflowNode["outputPorts"]): Promise<void>;
  isStopped(runId: string): boolean;
  waitForPoll(runId: string, nodeId: string, started: number, interval: number, halted: Halted, status?: "waiting" | "pending"): Promise<boolean>;
  stopBeforeDispatch(runId: string): Promise<void>;
  resolveInputGenerations(runId: string, node: WorkflowNode, values: WorkflowValue[], halted: Halted,
    started?: number, readLatest?: (canvas: CanvasNode[]) => WorkflowValue[]): Promise<boolean>;
  deliverMediaAsset(run: WorkflowRun, node: WorkflowNode, asset: Asset, halted: Halted, resultId?: string): Promise<void>;
  chatResult(runId: string, node: WorkflowNode, step: WorkflowStep, assets: Asset[], halted: Halted): Promise<Record<string, WorkflowValue> | null>;
  localDsResult(runId: string, node: WorkflowNode, step: WorkflowStep, paths: string[], halted: Halted): Promise<Record<string, WorkflowValue> | null>;
  writeAgentText(runId: string, node: WorkflowNode, value: WorkflowValue, writers: WorkflowNode[], halted: Halted): Promise<void>;
  writeAgentResult(runId: string, node: WorkflowNode, value: WorkflowValue, hasWriters: boolean, halted: Halted): Promise<void>;
  runComfyAutoGeneration(runId: string, node: WorkflowNode, halted: Halted, input: ComfyVideoInput,
    start?: WorkflowCardStart, text?: string, preview?: WorkflowStep["generationRunInput"]): Promise<void>;
  runComfyAutoImage(runId: string, node: WorkflowNode, halted: Halted, input: H3ImageGenerationInput, start?: WorkflowCardStart): Promise<void>;
  runWorkflowImageSession(runId: string, node: WorkflowNode, halted: Halted, input?: WorkflowImageSessionInput): Promise<void>;
}

export async function executeVoiceCard(host: WorkflowCardExecution, runId: string, node: WorkflowNode, halted: Halted,
  values?: Inputs, sourceVideoId?: string) {
  const run = host.run(runId);
  const voice = node.voice ?? {};
  let request: VoiceCardRequest | undefined = run.steps[node.id].voiceRequest;
  const recovering = !!request;
  if (!request) {
    const environment = await voiceApi.environment();
    if (environment.phase !== "ready") throw new Error(environment.message);
    const key = crypto.randomUUID();
    let text = [...(values?.text ?? []).map(value => value.text), node.prompt].filter(Boolean).join("\n").trim();
    let preview: Parameters<typeof voiceApi.start>[3];
    request = { key };
    if (!voice.id) {
      if (run.order.length !== 1 && !node.inputs.image?.[0]?.videoAudio) {
        throw new Error("请先为角色声音卡片选择声音");
      }
      const ids = (values?.image ?? []).flatMap(value => value.assetIds ?? []);
      if (ids.length !== 1) throw new Error("请选择一段参考录音");
      const [asset] = await api.getAssetsByIds(ids);
      if (!asset || !isAudioPath(asset.store_path)) throw new Error("请选择音频素材作为参考录音");
      const clip = voiceCardClip(voice, asset);
      text = (voice.sampleText ?? defaultVoiceSample).trim();
      request.previewKey = voiceCardPreviewKey(voice, asset);
      if (sourceVideoId) request.videoAudio = { sourceAssetId: sourceVideoId, assetId: asset.id };
      preview = { assetId: asset.id, start: clip.start, end: clip.end, transcript: clip.transcript, draftKey: request.previewKey };
    }
    if (!text) throw new Error(voice.id ? "请输入配音台词" : "请输入试听台词");
    if (halted()) return;
    await host.step(runId, node.id, { status: "running", voiceRequest: request, detail: voice.id ? "正在生成配音" : "正在生成试听" });
    if (halted()) return;
    let jobId: string;
    try { jobId = await voiceApi.start(host.projectId, text, voice.id ?? null, preview, key); }
    catch (error) {
      const snapshot = await voiceApi.snapshot(host.projectId).catch(() => null);
      if (!snapshot) {
        if (!halted()) await host.step(runId, node.id, { status: "waiting", error: "提交状态待确认，点击继续以查询原任务" });
        return;
      }
      const original = snapshot.jobs.find(item => item.request_key === key);
      if (!original) throw error;
      jobId = original.id;
    }
    if (halted()) { await voiceApi.cancel(jobId); return; }
    request = { ...request, jobId };
    await host.step(runId, node.id, { voiceRequest: request });
  }
  let retrySave = recovering;
  const pollStarted = Date.now();
  while (!halted()) {
    if (run.accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("请登录原账号后继续取回配音");
    let snapshot: Awaited<ReturnType<typeof voiceApi.snapshot>>;
    try { snapshot = await voiceApi.snapshot(host.projectId); }
    catch (error) {
      if (!halted()) await host.step(runId, node.id, { status: "waiting", error: `配音查询中断，可继续查询原任务。${String(error)}` });
      return;
    }
    if (halted()) return;
    const identity: VoiceCardRequest = request;
    const job = snapshot.jobs.find(item => item.id === identity.jobId || item.request_key === identity.key);
    if (!job) { await host.step(runId, node.id, { status: "waiting", error: "尚未找到原配音任务，可继续查询" }); return; }
    if (!request.jobId) {
      request = { ...request, jobId: job.id };
      await host.step(runId, node.id, { voiceRequest: request });
    }
    if (job.status === "succeeded") {
      const asset = snapshot.assets.find(item => item.id === job.asset_id);
      if (!asset) throw new Error("配音素材已移除");
      if (!request.previewKey) {
        try { await host.deliverMediaAsset(host.run(runId), node, asset, halted, `workflow-voice:${job.id}`); }
        catch (error) {
          if (!halted()) await host.step(runId, node.id, { status: "waiting", error: `配音已保存，点击继续添加到画板。${String(error)}` });
          return;
        }
      }
      if (halted()) return;
      await host.step(runId, node.id, { voiceRequest: { ...request, assetId: asset.id } });
      await host.finish(runId, node, request.previewKey ? {} : { image: { type: "image", assetIds: [asset.id] } });
      return;
    }
    if (job.recoverable) {
      if (retrySave) { retrySave = false; await voiceApi.recover(job.id); continue; }
      await host.step(runId, node.id, { status: "waiting", error: "音频已生成，点击继续以重试保存" });
      return;
    }
    if (job.status !== "running") throw new Error(job.message);
    if (!await host.waitForPoll(runId, node.id, pollStarted, 1000, halted)) return;
  }
}

export async function runWorkflowComfyVideo(host: WorkflowCardExecution, runId: string, node: WorkflowNode, halted: Halted,
  input?: ComfyVideoInput, start?: WorkflowCardStart, generationRunInput?: WorkflowStep["generationRunInput"]) {
  const id = node.id, step = host.run(runId).steps[id], accountId = host.run(runId).accountId;
  const optimizedForThisRun = !!(step.comfyAutoGeneration?.input && step.comfyOptimization?.result);
  let jobId = step.jobId;
  let result: ComfyVideoStatus;
  let terminalFailure = false;
  const pollStarted = Date.now();
  const prepare = async (endpoint: string, mode: ComfyVideoMode, recovery?: { installation?: string | null }) => {
    let environment = await comfyEnvironment(recovery ? "recover" : "prepare", endpoint, undefined, recovery?.installation ?? undefined, mode);
    while (!halted()) {
      if (accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后重新运行");
      if (environment.phase === "ready") return environment.endpoint;
      if (environment.phase !== "starting" && environment.phase !== "installing") throw new Error(environment.message);
      host.progress(runId, id, environment.message);
      if (!await host.waitForPoll(runId, id, pollStarted, 1000, halted)) break;
      environment = await comfyEnvironment("status", endpoint, undefined, undefined, mode);
    }
    return null;
  };
  const queryStatus = async (idToQuery: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const status = await comfyVideo("status", host.projectId, idToQuery);
        if (status.status !== "offline" || attempt >= 3 || halted()) return status;
      } catch (error) {
        if (!String(error).includes("本机服务查询暂时中断") || attempt >= 3 || halted()) throw error;
      }
      host.progress(runId, id, "本机服务响应较慢，正在重试查询…");
      if (!await host.waitForPoll(runId, id, pollStarted, 2000, halted)) throw new Error("原任务等待结束");
    }
  };
  try {
    if (!jobId) {
      if (step.status !== "pending" && !optimizedForThisRun) {
        throw new Error("上次提交状态未知，请核对本机 ComfyUI 队列");
      }
      if (!input) throw new Error("缺少本地视频输入");
      host.progress(runId, id, "正在准备本机环境…");
      const endpoint = await prepare(input.endpoint, comfyVideoMode(input));
      if (!endpoint || halted()) return;
      input = { ...input, endpoint };
      jobId = crypto.randomUUID();
      await host.step(runId, id, { status: "running", jobId, dispatchAt: Date.now(), error: undefined, detail: "正在提交本机视频工作流",
        generationRunInput: generationRunInput ?? step.generationRunInput });
      if (halted()) return;
      if (start && !start.current()) { await host.stopBeforeDispatch(runId); return; }
      if (accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) {
        await host.step(runId, id, { status: "pending", jobId: undefined, error: "账号已切换，请登录原账号后继续生成。" });
        return;
      }
      start?.release();
      result = await comfyVideo("start", host.projectId, jobId, input);
    } else {
      await host.step(runId, id, { status: "running", error: undefined });
      result = await queryStatus(jobId);
    }
    let restarted = false;
    while (!halted()) {
      if (accountId !== (host.desktop.getState().cloudAuth?.user_id ?? null)) {
        await host.step(runId, id, { status: "waiting", error: "请登录原账号后继续取回视频" }); return;
      }
      if (result.status === "offline") {
        if (!result.originalService) throw new Error("请重新启动原 ComfyUI 服务，再点击继续查询原任务。");
        if (restarted) throw new Error("本机视频服务仍无法连接，原任务记录已保留。");
        restarted = true;
        const [original, mode, installation] = result.originalService;
        const endpoint = await prepare(original, mode, { installation });
        if (!endpoint || halted()) return;
        if (endpoint !== original) throw new Error("原任务使用的本机视频服务暂不可用。");
        result = await queryStatus(jobId);
        if (result.status === "unknown") {
          terminalFailure = true;
          throw new Error("本机视频服务已恢复，未找到上次任务的结果。可以点击运行重新生成。");
        }
        continue;
      }
      if (result.status === "done" && result.asset) {
        await host.deliverMediaAsset(host.run(runId), node, result.asset, halted);
        if (halted()) return;
        await host.step(runId, id, { detail: comfyVideoElapsed(result.elapsedMs) ? `视频已生成 · 用时 ${comfyVideoElapsed(result.elapsedMs)}` : "视频已生成", error: undefined, comfyProgress: undefined });
        await host.finish(runId, node, { image: { type: "image", assetIds: [result.asset.id] } });
        await emit("creative://changed", { projectId: host.projectId }); return;
      }
      if (result.status === "failed") { terminalFailure = true; throw new Error(result.message); }
      if (result.status === "cancelled") {
        await host.step(runId, id, { comfyCancelled: true, comfyProgress: undefined });
        terminalFailure = true; throw new Error(result.message);
      }
      if (result.status === "unknown") { await host.step(runId, id, { status: "waiting", error: result.message }); return; }
      host.progress(runId, id, result.message, result.progress ?? undefined);
      if (!await host.waitForPoll(runId, id, pollStarted, 2000, halted)) return;
      result = await queryStatus(jobId);
    }
  } catch (error) {
    if (halted()) return;
    if (!jobId && optimizedForThisRun) {
      await host.step(runId, id, { status: "waiting", detail: "提示词已优化，等待本机生成", error: `${String(error)}。继续时会沿用本次优化结果。` });
      return;
    }
    if (terminalFailure || !jobId) throw error;
    // Preserve the durable identity on all transport errors. Continue never submits anew.
    await host.step(runId, id, { status: "waiting", comfyProgress: undefined, error: `${String(error)}。可继续查询原任务，或点击停止取消本机生成。` });
  }
}

export async function executeLoopCard(host: WorkflowCardExecution, input: CardRun & {
  accountId: WorkflowRun["accountId"]; canvas: ProjectCanvasSnapshot | null;
  readCell: NonNullable<Parameters<typeof workflowInputValues>[2]>;
  prepareMediaInputs(node: WorkflowNode, inputs: WorkflowNode["inputs"], values: Inputs): Promise<void>;
}) {
  const { runId, node, halted, accountId, canvas, readCell, prepareMediaInputs } = input;
  const id = node.id;
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
}

export async function executeAgentCard(host: WorkflowCardExecution, input: CardRun & {
  step: WorkflowStep; orderedAssets: Asset[]; outputTargets: AgentOutputTarget[];
  agentInput: ReturnType<typeof compileAgentPrompt> | null;
  agentVisualProfile: NonNullable<WorkflowStep["agentInput"]>["visualProfile"];
}) {
  const { runId, node, step, halted, orderedAssets, outputTargets, agentInput, agentVisualProfile } = input;
  const id = node.id;
  const snapshot = step.agentInput ?? { ...agentInput!, visualProfile: agentVisualProfile };
  if (!step.agentInput) await host.step(runId, id, { agentInput: snapshot });
  if (!snapshot.prompt.trim()) throw new WorkflowNodeError("Agent 要求不能为空", node);
  if (outputTargets.length && !step.agentOutputTargets) await host.step(runId, id, { agentOutputTargets: outputTargets });
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
      host.progress(runId, id, current.status === "queued" ? "Cloud DSH 文本改写排队中" : "Cloud DSH 正在修改文本");
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
  await host.finish(runId, node, outputs);
  await emit("creative://changed", { projectId: host.projectId });
}

export async function executeComfyVideoCard(host: WorkflowCardExecution, execution: CardRun & {
  step: WorkflowStep; start?: WorkflowCardStart; values: Inputs; localVideoMode?: ComfyVideoMode;
  referenceImages?: string[]; prompt: string; linkedText: string; generationRunInput?: WorkflowStep["generationRunInput"];
}) {
  const { runId, node, step, halted, start, values, localVideoMode, referenceImages, prompt, linkedText, generationRunInput } = execution;
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
  else await runWorkflowComfyVideo(host, runId, node, halted, input, start, generationRunInput);
}

export async function executeGenerationCard(host: WorkflowCardExecution, input: CardRun & {
  step: WorkflowStep; start?: WorkflowCardStart; canvas: ProjectCanvasSnapshot | null; connectedNode: WorkflowNode;
  values: Inputs; video: boolean; orderedAssets: Asset[]; generationRunInput?: WorkflowStep["generationRunInput"];
  assetIds: string[]; prompt: string; visualProfileId: string | null; generated: ReturnType<typeof compileGenerationPrompt> | null;
}) {
  const { runId, node, step, halted, start, connectedNode, values, video, orderedAssets, generationRunInput, assetIds, prompt, visualProfileId, generated } = input;
  const id = node.id;
  let { canvas } = input;
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
        await host.step(runId, id, { generationRunInput, comfyAutoGeneration: { imageInput },
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
    const result = await host.desktop.getState().startGeneration(prompt, orderedAssets, ratio, provider, prompt,
      undefined, undefined, undefined, visualProfileId, { projectId: host.projectId, threadId: host.run(runId).threadId }, false, generation, identity);
    if (!result.accepted) throw new Error(result.error || "生成未完成");
    const turns = host.desktop.getState().genJobs[identity.jobId]?.turns ?? [];
    paths = (turns.find(turn => turn.turnKey === identity.turnKey) ?? (turns.length === 1 && !turns[0].turnKey ? turns[0] : undefined))?.images ?? [];
  }
  if (host.isStopped(runId)) return;
  const outputAssetIds = await Promise.all(paths.map(path => api.localAgentFindAssetId(path)));
  if (!outputAssetIds.length || outputAssetIds.some(id => !id)) {
    await host.step(runId, id, { status: "waiting", error: "本次生成产物尚未入库，请稍后继续取回" }); return;
  }
  await host.finish(runId, node, { image: { type: "image", assetIds: [...new Set(outputAssetIds as string[])] } });
}
