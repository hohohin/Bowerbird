import { contentTableRows, type ContentTable } from "./contentTable.ts";
import { comfyAudioLabel, comfyVideoMode, DEFAULT_COMFY_VIDEO, H3_R2V_LIMITS, type ComfyVideoMode } from "./comfyVideo.ts";
import type { VideoOptions } from "./videoGeneration";
import { workflowTriggerMode } from "./workflowTriggerSchedule.ts";
import { H3_IMAGE } from "./genProviders.ts";

export class WorkflowNodeError extends Error {
  node: WorkflowNode;
  constructor(message: string, node: WorkflowNode) { super(message); this.node = node; }
}
export class WorkflowInputError extends WorkflowNodeError {
  source: WorkflowInput;
  referenceLabel?: string;
  constructor(message: string, node: WorkflowNode, source: WorkflowInput, referenceLabel?: string) {
    super(message, node); this.source = source; this.referenceLabel = referenceLabel;
  }
}

/** Editable workflow wiring is independent from immutable generation history edges. */
export type WorkflowKind = "director3d" | "instruction" | "generation" | "skill" | "agent" | "comfy-video" | "voice" | "visual-profile" | "text" | "trigger" | "planner" | "loop";

export function workflowNodeRequiresPro(node: WorkflowNode): boolean {
  if (node.kind === "generation") return node.generation?.media === "video" && !!node.generation.localVideo;
  return node.kind !== "text";
}

export const WORKFLOW_CARD_DRAG_TYPE = "application/x-bowerbird-workflow-card";
export const H3_VIDEO_AUDIO_PORT = "reference-audio";
export const H3_R2V_INPUT_PORTS = { image: "reference-image", video: "reference-video", audio: "r2v-audio" } as const;
export const H3_R2V_INPUT_LIMITS: Readonly<Partial<Record<string, number>>> = {
  [H3_R2V_INPUT_PORTS.image]: H3_R2V_LIMITS.image,
  [H3_R2V_INPUT_PORTS.video]: H3_R2V_LIMITS.video,
  [H3_R2V_INPUT_PORTS.audio]: H3_R2V_LIMITS.audio,
};
export type WorkflowAction = "describe" | "reuse" | "layers";
export type WorkflowPortType = "text" | "image" | "visual-profile" | "session" | "signal";
export interface WorkflowValue { type: WorkflowPortType; text?: string; table?: ContentTable; assetIds?: string[]; referenceRanks?: number[]; imageRefs?: { asset_id: string; token: string }[]; profileId?: string; version?: number; summary?: string; nodeIds?: string[]; deliveries?: Record<string, { nodeId: string; cellId: string; append: boolean; value: WorkflowValue }> }
export interface WorkflowPort { id: string; label: string; type: WorkflowPortType }
interface WorkflowInputFields { dimension?: { id?: string | null; title: string; body: string }; slot?: number; nodeId?: string; portId?: string; assetId?: string; assetNodeId?: string; groupId?: string; assetIds?: string[]; canvasNodeId?: string; cellId?: string; autoConnect?: string; mediaFilter?: ("image" | "video" | "audio")[];
  /** A submitted image was still rendering when this completion listener was added. */
  pendingCompletionSession?: string;
  /** Per-member position in this generation card's reference strip, set by dragging. */
  referenceRanks?: number[];
  excludedAssetIds?: string[];
  h3TailOnly?: boolean;
}
export type WorkflowInput = WorkflowInputFields & (
  { videoFrame?: { position: "first" | "last"; assetId?: string }; videoAudio?: never }
  | { videoFrame?: never; videoAudio: { assetId?: string } }
);
export interface WorkflowPromptReference { slot?: number; id: string; type: "text" | "image"; input: WorkflowInput; assetId?: string; label: string; direction?: "output" }
export interface WorkflowNode {
  /** Duration of the library shot before rounding to a supported generation length. */
  sourceShotDurationMs?: number;
  directorDocument?: unknown;
  directorVideoId?: string;
  directorVideoRenderKey?: string;
  voice?: import("./voiceCard").VoiceCardSettings;
  id: string; kind: WorkflowKind; x: number; y: number;
  /** Last measured canvas size; presentation only, saved with the next workflow change. */
  layoutSize?: { width: number; height: number };
  action: WorkflowAction; skill: string; prompt: string; ratio: string | null; provider: string;
  generation?: import("./videoGeneration").GenerationSettings;
  comfyVideo?: import("./comfyVideo").ComfyVideoOptions;
  h3Prompt?: H3CardPrompt;
  /** A local audio connection is inactive when the card uses a remote video model. */
  savedComfyAudio?: WorkflowInput[];
  /** R2V connections have no equivalent sockets on remote video cards. */
  savedComfyR2V?: Partial<Record<typeof H3_R2V_INPUT_PORTS[keyof typeof H3_R2V_INPUT_PORTS], WorkflowInput[]>>;
  /** Reversible rendering of ordinary @ mentions in the H3 text editor. */
  videoPrompt?: { ordinary: string; local: string };
  /** Ordinary input positions assigned to each H3 frame, including after its source is replaced. */
  videoFrameSlots?: Pick<WorkflowInput, "slot" | "referenceRanks">[];
  promptReferences?: WorkflowPromptReference[];
  overwriteDescribe?: boolean;
  describeCache?: { instruction: string; results: { assetId: string; sections: { title: string; body: string }[] }[] };
  agentTransport?: "local-ds" | "codex-cli" | "cloud";
  chatConversationId?: string;
  chatProvider?: import("./chatProvider").ChatProvider;
  chatCodexOptions?: import("./localChat").ChatCodexOptions;
  chatDshSkill?: import("./dshSkill").DshSkill;
  loopMode?: "images" | "rows" | "count";
  loopCount?: number;
  loopStartItem?: number;
  planning?: import("./workflowPlanner").WorkflowPlanningState;
  templateInstance?: import("./workflowTemplates").TemplateInstance;
  inputs: Record<string, WorkflowInput[]>;
  outputs: Record<string, WorkflowValue>;
  outputPorts: WorkflowPort[];
  trigger: boolean;
  triggerCount?: number;
  triggerMode?: "manual" | "daily" | "once" | "completion";
  triggerSchedule?: { id: string; at: number; dailyAt?: string; status: "armed" | "fired" | "missed" | "failed" };
  /** Native session turns already observed; prevents duplicate completion events. */
  completionSeen?: string[];
  sessionNodeIds?: string[];
  activeSessionNodeId?: string | null;
  resultNodeIds?: string[];
  resultGroupId?: string;
  textTarget?: { nodeId: string; cellId: string; cellIds?: string[]; tableCellIds?: string[][]; append?: boolean; image?: boolean; appendAxis?: "row" | "column"; axisCellIds?: string[]; axisOffset?: number; automaticImageRelay?: boolean };
  textSource?: string;
  profileId?: string;
  profileName?: string;
  profileCache?: { inputKey: string; profileId: string };
}
export interface WorkflowAgentEvent { id: string; kind: "message" | "tool" | "text-preview"; text: string; status: string; at: number }
export interface H3ImageGenerationInput {
  assetIds: string[];
  referenceNodeIds: (string | null)[];
  ratio: string | null;
  visualProfileId: string | null;
  promptParts?: GenerationPromptParts;
}
export interface WorkflowStep {
  dispatchAt?: number;
  generationRunInput?: { prompt: string; references: string[][] };
  voiceRequest?: import("./voiceCard").VoiceCardRequest;
  comfyProgress?: import("./comfyVideo").ComfyVideoProgress;
  comfyCancelled?: boolean;
  comfyStopping?: boolean;
  /** An opted-in manual Run, with the local inputs frozen before dispatching Cloud optimization. */
  comfyAutoGeneration?: { input?: import("./comfyVideo").ComfyVideoInput; imageInput?: H3ImageGenerationInput; videoText?: string };
  comfyOptimization?: { input: import("./h3PromptOptimization").H3PromptInput | import("./h3PromptOptimization").H3ImagePromptInput; instruction: string; inputBindings?: string; createdAt?: number; submissionStarted?: boolean; keptOriginal?: boolean; result?: string; dshContinuation?: true };
  agentInput?: { prompt: string; source: string; assetIds: string[]; visualProfile?: import("./types").VisualProfileDetail | null };
  chatInput?: import("./localChat").LocalChatSendInput;
  chatConversationId?: string;
  chatTurnId?: string;
  confirmedFailedChatTurnId?: string;
  agentOutputs?: Record<string, WorkflowValue>;
  /** Actual ingested media, before routing can mix in reference assets. */
  generatedAssetIds?: string[];
  agentProgress?: { text: string; at: number }[];
  agentOutputTargets?: import("./workflowAgentOutputs").AgentOutputTarget[];
  contentTarget?: WorkflowNode["textTarget"];
  agentSessionDeliveries?: Record<string, { target: NonNullable<WorkflowNode["textTarget"]>; done?: boolean }>;
  retrySafe?: boolean;
  localDsRequestId?: string;
  videoProjectPath?: string;
  localAgentTransport?: "local-ds" | "codex-cli";
  localAgentSkill?: "hyperframes";
  localDsImageProvider?: string;
  localDsGenerationMode?: "session";
  localDsGenerations?: Record<string, { request: WorkflowAgentGenerationRequest; jobId: string; turnKey: string; response?: WorkflowAgentGenerationResponse }>;
  diagnostic?: import("./workflowDiagnostics").WorkflowDiagnostic;
  describeJobIds?: string[];
  turnKey?: string;
  /** New image cards hand off a durable session; absent means legacy result-waiting. */
  generationSubmission?: "pending" | "submitted";
  /** The last original-video lookup found an active task. Keep it until Stop or recovery. */
  videoJobActive?: boolean;
  detail?: string;
  status: "pending" | "running" | "waiting" | "done" | "failed";
  error?: string; jobId?: string; agentRunId?: string; assetId?: string; profileId?: string; layerRequestKey?: string;
}
export interface WorkflowAgentGenerationRequest { id: string; prompt: string; images: string[]; ratio: string | null }
export interface WorkflowAgentGenerationResponse { images?: string[]; error?: string; submitted?: { jobId: string; turnKey: string; sessionNodeId: string } }
export interface WorkflowRun {
  id: string; startId: string; threadId: string; order: string[];
  manualCardRun?: true;
  scheduleId?: string;
  accountId?: string | null;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  steps: Record<string, WorkflowStep>;
  lockedNodeIds?: string[];
  writeNodeIds?: string[];
  cellTexts?: Record<string, string>;
  cellValues?: Record<string, WorkflowValue>;
  loop?: WorkflowLoop;
  /** Durable completion events, consumed together with the next execution and counter. */
  triggerQueue?: string[];
  completionRecoveryOnly?: boolean;
}
export interface WorkflowLoopItem { text: string; assetIds: string[]; table?: ContentTable }
export interface WorkflowLoop {
  nodeId: string; bodyIds: string[]; index: number;
  startIndex?: number;
  items?: WorkflowLoopItem[];
  completed: { outputs: Record<string, Record<string, WorkflowValue>>; steps: Record<string, WorkflowStep> }[];
}
export interface CanvasWorkflow { cardNames?: Record<string, string>; schema_version: 1; nodes: WorkflowNode[]; run: WorkflowRun | null; runs?: WorkflowRun[] }
export interface WorkflowSnapshot { revision: number; document: CanvasWorkflow }
export const emptyWorkflow = (): CanvasWorkflow => ({ schema_version: 1, nodes: [], run: null });

// These are methods of the existing unified Agent, never separate Agent runners.
export const WORKFLOW_SKILLS = [
  { id: "image-edit", label: "图片创作", instruction: "请读取并使用 bowerbird-controlled-image-edit 技能完成以下任务，交付图片。", image: true },
  { id: "html-layout", label: "HTML 图文排版", instruction: "请读取并使用 bowerbird-html-layout-render 技能完成以下任务，交付排版截图。", image: true },
] as const;

/** Both provider selection and older local-provider drafts use the toolbox H3 contract. */
export function normalizeWorkflowLocalVideo(node: WorkflowNode): WorkflowNode {
  if (node.kind !== "generation" || node.generation?.media !== "video" || !node.generation.localVideo) return node;
  node = normalizeWorkflowInputSlots(node);
  const images = node.inputs.image ?? [];
  const refs = node.promptReferences ?? [];
  const ordered: WorkflowInput[] = [];
  for (const match of node.prompt.matchAll(/@\[([^\]]+)\]/g)) {
    const ref = refs.find(ref => ref.id === match[1] && ref.type === "image" && ref.direction !== "output");
    const input = ref && images.find(input => workflowReferenceMatchesInput(ref, input));
    if (input && !ordered.includes(input)) ordered.push(input);
  }
  // Connected images work without mentions. Preserve extra inputs so validation can report them.
  ordered.push(...images.filter(input => !ordered.includes(input)));
  // H3 assigns a whole source to each named frame socket. Only transfer an order
  // that can be expressed without splitting a multi-image source between sockets.
  if (ordered.some(input => input.referenceRanks?.length) && ordered.every(input =>
    (input.referenceRanks?.length ?? 0) <= 1 && (input.assetIds?.length ?? 0) <= 1)) {
    const rank = (input: WorkflowInput) => input.referenceRanks?.[0] === undefined || input.referenceRanks[0] < 0 ? Infinity : input.referenceRanks[0];
    ordered.sort((left, right) => rank(left) - rank(right));
  }
  const frames = ordered.flatMap(input => !workflowImageContainer(input) && input.assetIds?.length
    ? input.assetIds.map(assetId => ({ ...input, assetIds: undefined, assetId })) : [input]);
  const prompt = node.prompt.replace(/@\[([^\]]+)\]/g, (token, id: string) => {
    const ref = refs.find(ref => ref.id === id && ref.direction !== "output");
    if (!ref) return token;
    if (ref.type === "text") return ""; // The H3 text port supplies its current contents at execution.
    const index = ordered.findIndex(input => workflowReferenceMatchesInput(ref, input));
    if (comfyVideoMode(node.generation!.localVideo) === "reference" && index === 0) return "<Picture 1>";
    return index < 0 ? ref.label : `@图片${index + 1}`;
  }).trim();
  const { image: _image, ...inputs } = node.inputs;
  const tailOnly = frames.length === 1 && frames[0].h3TailOnly;
  return { ...node, kind: "comfy-video", comfyVideo: node.generation!.localVideo, prompt,
    savedComfyAudio: undefined, savedComfyR2V: undefined,
    videoFrameSlots: frames.map(({ slot, referenceRanks }) => ({ slot, referenceRanks })),
    videoPrompt: prompt === node.prompt ? undefined : { ordinary: node.prompt, local: prompt },
    generation: { ...node.generation, localVideo: undefined },
    inputs: { ...inputs, ...node.savedComfyR2V, "first-frame": inputs["first-frame"] ?? (tailOnly ? [] : frames.slice(0, 1)), "last-frame": inputs["last-frame"] ?? (tailOnly ? frames : frames.slice(1)),
      ...(node.savedComfyAudio?.length ? { [H3_VIDEO_AUDIO_PORT]: node.savedComfyAudio } : {}) } };
}

export function selectWorkflowVideoProvider(node: WorkflowNode, channel: "jimeng" | "cloud" | "h3", options?: VideoOptions): WorkflowNode {
  if (channel === "h3") return node.kind === "comfy-video" ? node : normalizeWorkflowLocalVideo({
    ...node, generation: { ...node.generation, media: "video", localVideo: node.comfyVideo ?? { ...DEFAULT_COMFY_VIDEO } },
  });
  const generation = { ...node.generation, media: "video" as const, localVideo: undefined, videoChannel: channel,
    videoOptions: options ?? node.generation?.videoOptions };
  if (node.kind !== "comfy-video") return { ...node, generation };
  const { "first-frame": first = [], "last-frame": last = [], [H3_VIDEO_AUDIO_PORT]: audio,
    [H3_R2V_INPUT_PORTS.image]: referenceImages, [H3_R2V_INPUT_PORTS.video]: referenceVideos,
    [H3_R2V_INPUT_PORTS.audio]: referenceAudios, ...inputs } = node.inputs;
  const savedComfyR2V = referenceImages?.length || referenceVideos?.length || referenceAudios?.length ? {
    [H3_R2V_INPUT_PORTS.image]: referenceImages, [H3_R2V_INPUT_PORTS.video]: referenceVideos,
    [H3_R2V_INPUT_PORTS.audio]: referenceAudios,
  } : undefined;
  const frames = [...first, ...last];
  const prompt = node.videoPrompt?.local === node.prompt ? node.videoPrompt.ordinary : node.prompt;
  // Slot numbers belong to the ordinary editor. The H3 sockets can be in
  // mention order, and a user can replace a socket's source while on H3.
  const editedPrompt = node.videoPrompt && node.videoPrompt.local !== node.prompt;
  const remoteInput = (input: WorkflowInput) => input.autoConnect || (node.videoFrameSlots && input.slot && !editedPrompt)
    ? input : { ...input, autoConnect: crypto.randomUUID() };
  const ordered = frames.map((input, index) => {
    const previous = node.videoFrameSlots?.[first.length ? index : index + 1];
    return { ...previous, ...remoteInput(input),
      h3TailOnly: !first.length && index === 0 || undefined };
  })
    .sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity));
  // A legacy literal asset list uses one ordinary slot but occupies multiple H3 sockets.
  const image: WorkflowInput[] = [];
  for (const input of ordered) {
    const previous = image[image.length - 1];
    if (input.slot && previous?.slot === input.slot && !input.videoFrame && !previous.videoFrame
      && !workflowImageContainer(input) && input.assetId && !workflowImageContainer(previous) && (previous.assetId || previous.assetIds?.length)) {
      previous.assetIds = [...(previous.assetIds ?? [previous.assetId!]), input.assetId];
      delete previous.assetId;
    } else image.push(input);
  }
  return normalizeWorkflowInputSlots({ ...node, kind: "generation", generation, prompt, videoPrompt: undefined, videoFrameSlots: undefined,
    savedComfyAudio: audio?.length ? audio : undefined, savedComfyR2V,
    inputs: { ...inputs, image, text: (inputs.text ?? []).map(remoteInput) } });
}

export function workflowInputs(node: WorkflowNode): WorkflowPort[] {
  if (node.kind === "director3d") return [{id:"image",label:"场景参考图",type:"image"}];
  if (node.kind === "voice") return node.voice?.id
    ? [{ id: "text", label: "台词", type: "text" }]
    : [{ id: "image", label: "参考录音", type: "image" }];
  if (node.kind === "trigger") return [{ id: "completion", label: "完成触发", type: "signal" }];
  if (node.textSource) return [];
  if (node.kind === "comfy-video") {
    const mode = comfyVideoMode(node.comfyVideo);
    if (mode === "r2v") return [
      { id: H3_R2V_INPUT_PORTS.image, label: "参考图片", type: "image" },
      { id: H3_R2V_INPUT_PORTS.video, label: "参考视频", type: "image" },
      { id: H3_R2V_INPUT_PORTS.audio, label: "参考音频", type: "image" },
      { id: "text", label: "文本", type: "text" },
    ];
    return [...(mode !== "text" ? [{ id: "first-frame", label: mode === "reference" ? "参考图" : "首帧", type: "image" as const }] : []),
      ...(mode === "frames" ? [{ id: "last-frame", label: "尾帧（可选）", type: "image" as const }] : []), { id: "text", label: "文本", type: "text" },
      { id: H3_VIDEO_AUDIO_PORT, label: comfyAudioLabel(mode), type: "image" }];
  }
  if (node.kind === "loop") return node.loopMode === "count" ? [] : node.loopMode === "rows" ? [{ id: "text", label: "内容行", type: "text" }] : [{ id: "image", label: "图片列表", type: "image" }];
  if (node.kind === "instruction") return [{ id: "image", label: "图片", type: "image" }];
  const ports: WorkflowPort[] = [{ id: "text", label: "文本", type: "text" }, { id: "image", label: node.kind === "generation" && node.generation?.media === "video" ? "参考素材" : "图片", type: "image" }];
  if (node.kind === "generation" || node.kind === "skill" || node.kind === "agent") ports.push({ id: "visual-profile", label: "视觉规范", type: "visual-profile" });
  return ports;
}
export const workflowProducesVideo = (node: WorkflowNode) => node.kind === "comfy-video" || node.kind === "director3d"
  || node.kind === "generation" && node.generation?.media === "video" || node.kind === "agent" && node.skill === "hyperframes";
export const workflowFrameLabel = (frame: NonNullable<WorkflowInput["videoFrame"]>) => frame.position === "first" ? "首帧画面" : "尾帧画面";
export const workflowVideoAudioLabel = () => "视频音频";
export const workflowInputAssetId = (input: WorkflowInput) => input.videoAudio?.assetId ?? input.videoFrame?.assetId ?? input.assetId;
export function workflowOutputs(node: WorkflowNode): WorkflowPort[] {
  if (node.kind === "director3d") return [{id:"image",label:"MP4",type:"image"}];
  if (node.kind === "voice") return node.voice?.id ? [{ id: "image", label: "配音", type: "image" }] : [];
  if (node.kind === "comfy-video") return [{ id: "image", label: "视频", type: "image" }];
  if (node.kind === "planner") return [];
  if (node.kind === "loop") return node.loopMode === "count" ? [{ id: "iteration", label: "当前轮次", type: "text" }] : node.loopMode === "rows"
    ? [{ id: "text", label: "当前行文字", type: "text" }, { id: "image", label: "当前行图片", type: "image" }, { id: "iteration", label: "当前轮次", type: "text" }]
    : [{ id: "image", label: "当前图片", type: "image" }, { id: "iteration", label: "当前轮次", type: "text" }];
  if (node.kind === "agent") return [{ id: "text", label: "返回文字", type: "text" },
    ...(usesConnectedAgentInputs(node) ? [{ id: "image", label: node.skill === "hyperframes" ? "返回视频" : "返回图片", type: "image" as const }] : [])];
  if (node.kind === "trigger") return [{ id: "signal", label: "触发", type: "signal" }];
  if (node.kind === "text") return node.textTarget?.image ? [{ id: "image", label: "图片", type: "image" }] : [{ id: "text", label: "文本", type: "text" }];
  if (node.kind === "generation") return [{ id: "image", label: node.generation?.media === "video" ? "视频" : "图片", type: "image" }];
  if (node.kind === "visual-profile") return [{ id: "visual-profile", label: "视觉规范", type: "visual-profile" }];
  if (node.kind !== "instruction") return [{ id: "image", label: node.kind === "skill" && node.skill === "html-layout" ? "排版截图" : "图片", type: "image" }];
  if (node.action === "reuse") return [{ id: "text", label: "生成提示词", type: "text" }, { id: "image", label: "参考图片", type: "image" }];
  if (node.action === "describe") return [{ id: "text", label: "提示词", type: "text" }];
  return [{ id: "image", label: "产物", type: "image" }];
}
export function workflowTitle(node: WorkflowNode): string {
  if (node.kind === "director3d") return "3D 导演台";
  if (node.kind === "voice") return "角色声音";
  if (node.templateInstance) return `子流程 · ${node.templateInstance.template.name}`;
  if (node.kind === "comfy-video" || node.kind === "generation" && node.generation?.media === "video") return "视频生成";
  if (node.kind === "planner") return "工作流助手";
  if (node.kind === "loop") return "循环卡片";
  if (node.kind === "agent") return "Agent 卡片";
  if (node.textSource) return "文本卡片";
  if (node.kind === "text") return "写入文本单元格";
  if (node.kind === "trigger") return "触发器卡片";
  return node.kind === "visual-profile" ? "视觉规范卡片" : node.kind === "generation" ? "生成卡片" : node.kind === "skill" ? "技能卡片" : "指令卡片";
}
export function newWorkflowNode(kind: WorkflowKind, x: number, y: number, provider: string): WorkflowNode {
  return { id: crypto.randomUUID(), kind, x, y, action: "describe", skill: "image-edit", prompt: "", ratio: null,
    provider, inputs: {}, outputs: {}, outputPorts: [], trigger: false, ...(kind === "agent" ? { chatProvider: "codex-local" as const } : {}), ...(kind === "trigger" ? { triggerCount: 1 } : {}) };
}

export function workflowCompletionOutput(node: WorkflowNode): WorkflowPort | undefined {
  if (node.kind !== "trigger" && !node.textSource && !node.textTarget) return workflowOutputs(node)[0];
}

export function workflowCompletionTarget(node: WorkflowNode): boolean {
  return node.kind !== "trigger" && node.kind !== "planner" && !node.textTarget;
}

export function workflowConnectionError(nodes: WorkflowNode[], fromId: string, portId: string, toId: string, inputId: string): string | null {
  const from = nodes.find(node => node.id === fromId), to = nodes.find(node => node.id === toId);
  if (!from || !to) return "连接的卡片已不存在";
  if (fromId === toId) return "不能连接卡片自身";
  const output = workflowOutputs(from).find(port => port.id === portId);
  if (to.kind === "trigger" && inputId === "completion") return output && from.kind !== "trigger" && !from.textSource ? null : "请连接执行卡片的输出端口";
  const input = inputId === "signal" && to.kind !== "trigger" && to.kind !== "planner" ? { type: "signal" } : workflowInputs(to).find(port => port.id === inputId);
  if (!output || !input || input.type !== output.type) return "只能连接相同类型的端口";
  return workflowConnectionCycleError(nodes, { nodeId: fromId }, toId);
}

/** Connection validation may follow generated-media provenance without changing how saved inputs execute. */
export function workflowConnectionCycleError(nodes: WorkflowNode[], source: WorkflowInput, targetId: string,
  generationOrigins?: ReadonlyMap<string, Pick<WorkflowNode, "id">>): string | null {
  const inputProducers = indexWorkflowInputProducers(nodes);
  const sourceIds = (input: WorkflowInput) => {
    const ids = inputProducers(input);
    const materialId = input.assetNodeId ?? input.canvasNodeId;
    const origin = materialId ? generationOrigins?.get(materialId) : undefined;
    return origin && !ids.includes(origin.id) ? [...ids, origin.id] : ids;
  };
  const producers = sourceIds(source);
  if (producers.includes(targetId)) return "不能连接卡片自身";
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === targetId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const node = byId.get(id);
    return !!node && Object.values(workflowExecutionInputs(node)).flat().some(binding => sourceIds(binding).some(visit));
  };
  return producers.some(visit) ? "这条连接会形成循环" : null;
}

/** Invalidate descendants when a definition changes; stale values never cross a wire. */
export function workflowInputProducer(nodes: WorkflowNode[], input: WorkflowInput): string | undefined {
  return input.nodeId ?? (input.canvasNodeId ? (nodes.find(node => node.textTarget?.nodeId === input.canvasNodeId && (node.textTarget?.cellId === input.cellId || node.textTarget?.cellIds?.includes(input.cellId ?? "")))
    ?? nodes.find(node => node.resultNodeIds?.includes(input.canvasNodeId!)))?.id : undefined);
}

export function workflowInputProducers(nodes: WorkflowNode[], input: WorkflowInput): string[] {
  if (input.canvasNodeId && ["*", "*text", "*latest", "*latest-image"].includes(input.cellId ?? "")) return nodes.filter(node => node.textTarget?.nodeId === input.canvasNodeId || node.resultNodeIds?.includes(input.canvasNodeId!)).map(node => node.id);
  const id = workflowInputProducer(nodes, input);
  return id ? [id] : [];
}

function indexWorkflowInputProducers(nodes: WorkflowNode[]) {
  const writers = new Map<string, Map<string, string>>();
  const automaticResults = new Map<string, string>();
  const tableProducers = new Map<string, string[]>();
  for (const node of nodes) {
    const target = node.textTarget;
    if (target) {
      const cells = writers.get(target.nodeId) ?? new Map<string, string>();
      for (const cell of [target.cellId, ...(target.cellIds ?? [])]) if (!cells.has(cell)) cells.set(cell, node.id);
      writers.set(target.nodeId, cells);
    }
    for (const result of node.resultNodeIds ?? []) if (!automaticResults.has(result)) automaticResults.set(result, node.id);
    for (const table of new Set([...(target ? [target.nodeId] : []), ...(node.resultNodeIds ?? [])])) {
      const producers = tableProducers.get(table) ?? [];
      producers.push(node.id);
      tableProducers.set(table, producers);
    }
  }
  return (input: WorkflowInput): string[] => {
    if (input.canvasNodeId && ["*", "*text", "*latest", "*latest-image"].includes(input.cellId ?? "")) return tableProducers.get(input.canvasNodeId) ?? [];
    const id = input.nodeId ?? (input.canvasNodeId ? writers.get(input.canvasNodeId)?.get(input.cellId ?? "") ?? automaticResults.get(input.canvasNodeId) : undefined);
    return id ? [id] : [];
  };
}

function workflowSaveDependencies(node: WorkflowNode): WorkflowNode["inputs"] {
  if (node.kind === "trigger") return {};
  if (node.kind !== "comfy-video") return node.inputs;
  const r2v = comfyVideoMode(node.comfyVideo) === "r2v";
  // Keep legacy inactive-frame validation without treating parked R2V sources as live edges.
  return Object.fromEntries(Object.entries(node.inputs).filter(([port]) => r2v
    ? !["first-frame", "last-frame", H3_VIDEO_AUDIO_PORT].includes(port) : !Object.prototype.hasOwnProperty.call(H3_R2V_INPUT_LIMITS, port)));
}

/** Wiring checks graph structure, independently of prompt validity or cached outputs. */
export function assertWorkflowAcyclic(nodes: WorkflowNode[], startId: string, includeInactiveInputs = false): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const inputProducers = indexWorkflowInputProducers(nodes);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("这条连接会形成循环");
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id);
    const inputs = node ? includeInactiveInputs ? workflowSaveDependencies(node) : workflowExecutionInputs(node) : {};
    for (const input of Object.values(inputs).flat()) {
      for (const producer of inputProducers(input)) visit(producer);
    }
    visiting.delete(id);
    visited.add(id);
  };
  visit(startId);
}

export function invalidateWorkflow(nodes: WorkflowNode[], changedId: string): WorkflowNode[] {
  const inputProducers = indexWorkflowInputProducers(nodes);
  const downstream = new Map<string, Set<string>>();
  for (const node of nodes) for (const input of Object.values(workflowExecutionInputs(node)).flat()) {
    if (input.portId === "signal") continue;
    for (const producer of inputProducers(input)) {
      const consumers = downstream.get(producer) ?? new Set<string>();
      consumers.add(node.id);
      downstream.set(producer, consumers);
    }
  }
  const ids = new Set([changedId]);
  for (const id of ids) for (const consumer of downstream.get(id) ?? []) ids.add(consumer);
  return nodes.map(node => ids.has(node.id) ? { ...node, outputs: {} } : node);
}

/** Run downstream of the key plus missing prerequisites, without starting their unrelated branches. */
export function workflowOrder(nodes: WorkflowNode[], startId: string, single = false): string[] {
  nodes = workflowExecutionNodes(nodes, startId);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(startId)) throw new Error("起点卡片不存在");
  const inputProducers = indexWorkflowInputProducers(nodes);
  const upstream = new Map<string, { input: WorkflowInput; producer: string }[]>();
  const downstream = new Map<string, Set<string>>();
  const downstreamWriters = new Map<string, Set<string>>();
  for (const node of nodes) {
    const bindings = Object.values(node.inputs).flat().flatMap(input => inputProducers(input).map(producer => ({ input, producer })));
    upstream.set(node.id, bindings);
    for (const { producer } of bindings) {
      const consumers = downstream.get(producer) ?? new Set<string>();
      consumers.add(node.id);
      downstream.set(producer, consumers);
      if (node.textTarget) {
        const writers = downstreamWriters.get(producer) ?? new Set<string>();
        writers.add(node.id);
        downstreamWriters.set(producer, writers);
      }
    }
  }
  const reachable = new Set([startId]);
  // Receiving content is part of delivering this card's output, even for a single-card run.
  const consumers = single ? downstreamWriters : downstream;
  for (const id of reachable) for (const consumer of consumers.get(id) ?? []) reachable.add(consumer);
  for (const id of reachable) {
    // Missing prerequisites added below also deliver to their receivers, without running other branches.
    for (const writer of downstreamWriters.get(id) ?? []) reachable.add(writer);
    if (single) continue;
    for (const { input, producer } of upstream.get(id) ?? []) {
      // A signal wire starts flows from the switch; it never pulls that trigger into another flow's execution.
      if (input.portId === "signal") continue;
      const source = byId.get(producer);
      if (!input.nodeId && source?.kind !== "text") continue;
      if (!source) throw new Error("连接的上游卡片已删除，请重新连接");
      // Image cells store their own value. Reading one does not replay an idle
      // input writer; writers reached by this run still execute before consumers.
      if (input.canvasNodeId && source.textTarget?.image && !reachable.has(producer)) continue;
      if (source.kind === "text" || !source.outputs[input.portId ?? "text"]) reachable.add(source.id);
    }
  }
  const inDegree = new Map<string, number>(), levels = new Map<string, number>(), queue: string[] = [];
  for (const id of reachable) {
    const degree = new Set(upstream.get(id)?.map(edge => edge.producer).filter(producer => reachable.has(producer))).size;
    inDegree.set(id, degree);
    if (degree === 0) queue.push(id);
  }
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index], level = levels.get(id) ?? 0;
    for (const consumer of downstream.get(id) ?? []) {
      const degree = inDegree.get(consumer);
      if (degree === undefined) continue;
      levels.set(consumer, Math.max(levels.get(consumer) ?? 0, level + 1));
      inDegree.set(consumer, degree - 1);
      if (degree === 1) queue.push(consumer);
    }
  }
  if (queue.length !== reachable.size) throw new Error("工作流包含循环，请先断开循环连接");
  // Preserve the existing within-wave order used by independent ready cards.
  const waves: string[][] = [];
  for (const id of reachable) (waves[levels.get(id) ?? 0] ??= []).push(id);
  return waves.flat();
}

/** A text-card start reads current cells without rerunning their producers. */
export function workflowExecutionNodes(nodes: WorkflowNode[], startId: string): WorkflowNode[] {
  nodes = nodes.filter(node => node.kind !== "planner");
  const byId = new Map(nodes.map(node => [node.id, node]));
  nodes = nodes.map(node => projectGenerationInputs({ ...node, inputs: workflowExecutionInputs(node) }, id => byId.get(id)));
  const start = nodes.find(node => node.id === startId);
  const sources = nodes.filter(node => node.textSource && (node.id === startId || (start?.kind === "trigger" && node.inputs.signal?.some(input => input.nodeId === startId))));
  if (!sources.length) return nodes;
  const sourcesByTable = new Map<string, WorkflowNode>();
  for (const source of sources) if (!sourcesByTable.has(source.textSource!)) sourcesByTable.set(source.textSource!, source);
  return nodes.map(node => ({ ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([port, inputs]) =>
    [port, inputs.map(input => { const source = input.canvasNodeId && sourcesByTable.get(input.canvasNodeId); return source ? { ...input, canvasNodeId: undefined, cellId: undefined, nodeId: source.id, portId: input.cellId } : input; })])) }));
}

/** Completion wires are events, never data prerequisites or an ordinary graph cycle. */
export function workflowExecutionInputs(node: WorkflowNode): WorkflowNode["inputs"] {
  if (node.kind === "comfy-video") {
    const active = new Set([...workflowInputs(node).map(port => port.id), "signal"]);
    return Object.fromEntries(Object.entries(node.inputs).filter(([id]) => active.has(id)));
  }
  return node.kind === "trigger" ? {} : node.inputs;
}
export function workflowCompletionTriggers(nodes: WorkflowNode[], sourceId: string): WorkflowNode[] {
  return nodes.filter(node => node.kind === "trigger" && workflowTriggerMode(node) === "completion" && (node.triggerCount ?? 0) > 0
    && node.inputs.completion?.some(input => input.nodeId === sourceId));
}
export const workflowReferenceToken = (id: string) => `@[${id}]`;
export function workflowPromptPreview(node: WorkflowNode, label = (ref: WorkflowPromptReference) => ref.label): string {
  return node.prompt.replace(/@\[([^\]]+)\]/g, (_, id) => {
    const ref = node.promptReferences?.find(ref => ref.id === id);
    return `@${ref ? label(ref) : "输入"}`;
  });
}
// Dimension text and its companion image share a drawn wire, but detach independently.
export function workflowDisconnectId(input: WorkflowInput) {
  return input.autoConnect && input.dimension
    ? JSON.stringify(["dimension", input.autoConnect, input.assetId, input.dimension.id ?? input.dimension.title])
    : input.autoConnect;
}

export const workflowBindingKey = (input: WorkflowInput) => JSON.stringify([input.nodeId, input.portId, input.assetId, input.groupId, input.canvasNodeId, input.cellId, input.assetNodeId,
  ...(input.dimension ? [input.dimension.id ?? input.dimension.title] : []),
  ...(input.videoFrame ? [{ videoFrame: input.videoFrame.position }] : []),
  ...(input.videoAudio ? [{ videoAudio: true }] : [])]);
/** An upstream card, folder or native cell owns the reference; its current images may change. */
export const workflowImageContainer = (input: WorkflowInput) => !!(input.nodeId || input.groupId || input.canvasNodeId);
export function activePromptReferences(node: WorkflowNode) {
  return (node.promptReferences ?? []).filter(ref => node.prompt.includes(workflowReferenceToken(ref.id)));
}
/** A pipe number is the current position among the receiving card's inputs of that type. */
export function normalizeWorkflowInputSlots(node: WorkflowNode): WorkflowNode {
  if (node.kind !== "generation" && node.kind !== "agent" && node.kind !== "planner") return node;
  let inputs = node.inputs;
  for (const type of ["text", "image"] as const) {
    const bindings = inputs[type];
    if (!bindings?.some((input, index) => input.slot !== index + 1)) continue;
    inputs = { ...inputs, [type]: bindings.map((input, index) => input.slot === index + 1 ? input : { ...input, slot: index + 1 }) };
  }
  let changed = inputs !== node.inputs;
  const promptReferences = node.promptReferences?.map(ref => {
    if (ref.direction === "output") return ref;
    // Planner mentions used source identities before numbered pipes. Migrate
    // those by their connected source once; explicit slots always mean position.
    const labelSlot = /^(?:文本|图片来源|生成结果|图片)\s*(\d+)(?:\.\d+)?$/.exec(ref.label)?.[1];
    const bindings = inputs[ref.type] ?? [];
    const slot = ref.slot ?? (node.kind === "planner"
      ? bindings.find(input => workflowBindingKey(ref.input) === workflowBindingKey(input))?.slot
      : (labelSlot ? Number(labelSlot) : undefined)
      ?? bindings.find(input => workflowReferenceMatchesInput(ref, input))?.slot
      ?? (bindings.length === 1 ? bindings[0].slot : undefined));
    const input = bindings.find(input => input.slot === slot) ?? ref.input;
    const label = slot ? `${ref.type === "text" ? "文本" : "图片来源"} ${slot}` : ref.label;
    if (slot === ref.slot && input === ref.input && label === ref.label && ref.assetId === undefined
      && Object.prototype.hasOwnProperty.call(ref, "slot") && Object.prototype.hasOwnProperty.call(ref, "assetId")) return ref;
    changed = true;
    return { ...ref, slot, input, assetId: undefined, label };
  });
  return changed ? { ...node, inputs, ...(promptReferences ? { promptReferences } : {}) } : node;
}
export function rebindGenerationReferences(node: WorkflowNode): WorkflowNode {
  return normalizeWorkflowInputSlots(node);
}
export const workflowReferenceMatchesInput = (ref: Pick<WorkflowPromptReference, "direction" | "slot" | "input">, input: WorkflowInput) =>
  ref.direction !== "output" && (ref.slot !== undefined ? ref.slot === input.slot : workflowBindingKey(ref.input) === workflowBindingKey(input));
export function isWorkflowGenerationResult(input: WorkflowInput, source?: WorkflowNode) {
  return !!source && source.id === input.nodeId && input.portId === "image" && (source.kind === "generation" || source.kind === "comfy-video");
}
function implicitGenerationInput(input: WorkflowInput, sourceById: (id: string) => WorkflowNode | undefined) {
  return !!input.autoConnect || (input.portId === "image" && !!input.nodeId && isWorkflowGenerationResult(input, sourceById(input.nodeId)));
}
export function generationInputNode(node: WorkflowNode, nodes: readonly WorkflowNode[] = []): WorkflowNode {
  return projectGenerationInputs(node, id => nodes.find(candidate => candidate.id === id));
}
function projectGenerationInputs(node: WorkflowNode, sourceById: (id: string) => WorkflowNode | undefined): WorkflowNode {
  if (node.kind === "comfy-video") return { ...node, inputs: workflowExecutionInputs(node) };
  if (node.kind !== "generation" && node.kind !== "agent") return node;
  node = rebindGenerationReferences(node);
  if (usesConnectedAgentInputs(node)) return node;
  const slots = new Set<number>(), bindings = new Set<string>();
  for (const ref of activePromptReferences(node)) {
    if (ref.type !== "text" || ref.direction === "output") continue;
    if (ref.slot !== undefined) slots.add(ref.slot);
    else bindings.add(workflowBindingKey(ref.input));
  }
  const text = (node.inputs.text ?? []).filter(input => implicitGenerationInput(input, sourceById)
    || (input.slot !== undefined && slots.has(input.slot)) || (bindings.size > 0 && bindings.has(workflowBindingKey(input))));
  return { ...node, inputs: { ...node.inputs, text, image: [...(node.inputs.image ?? [])] } };
}
function usesConnectedAgentInputs(node: WorkflowNode) {
  return node.kind === "agent";
}
function emptyCompanionPort(type: "text" | "image", index: number, inputs: WorkflowNode["inputs"], values: Record<string, WorkflowValue[]>) {
  const wire = inputs[type]?.[index]?.autoConnect;
  const populated = (port: "text" | "image", i: number) => port === "text" ? values.text?.[i]?.text?.trim() : values.image?.[i]?.assetIds?.length;
  if (!wire || populated(type, index)) return false;
  const other = type === "image" ? "text" : "image";
  return inputs[other]?.some((binding, i) => binding.autoConnect === wire && populated(other, i));
}

/** Keep new or previously unavailable members in their original order after ranked members. */
export function orderedGenerationReferences(inputs: WorkflowNode["inputs"], values: Record<string, WorkflowValue[]>, assetIds: string[]) {
  const ranks = new Map<string, number>();
  for (const type of ["text", "image"] as const) for (const [index, binding] of (inputs[type] ?? []).entries()) {
    if (!binding.referenceRanks) continue;
    const value = values[type]?.[index];
    const positions = value?.referenceRanks ?? binding.referenceRanks;
    value?.assetIds?.forEach((id, member) => {
      const rank = positions[member];
      if (Number.isSafeInteger(rank) && rank >= 0) ranks.set(id, Math.min(rank, ranks.get(id) ?? Infinity));
    });
  }
  return ranks.size ? [...assetIds].sort((a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity)) : assetIds;
}

export function reorderGenerationReferences(node: WorkflowNode, values: Record<string, WorkflowValue[]>, orderedAssetIds: string[]): WorkflowNode["inputs"] {
  const ranks = new Map(orderedAssetIds.map((id, index) => [id, index]));
  const inputs = { ...node.inputs };
  for (const type of ["text", "image"] as const) if (inputs[type]) {
    inputs[type] = inputs[type].map((binding, index) => {
      const positions = values[type]?.[index]?.assetIds?.map(id => ranks.get(id) ?? -1);
      if (positions?.some(rank => rank >= 0)) return { ...binding, referenceRanks: positions };
      if (!binding.referenceRanks) return binding;
      const { referenceRanks: _previous, ...rest } = binding;
      return rest;
    });
  }
  return inputs;
}

function generationMentionAssets(prompt: string, resolved: Map<string, WorkflowValue>) {
  const ids = new Set<string>();
  for (const match of prompt.matchAll(/@\[([^\]]+)\]/g)) {
    for (const id of resolved.get(match[1])?.assetIds ?? []) ids.add(id);
  }
  return ids;
}

export function filterDisconnectedReferences(inputs: WorkflowNode["inputs"], values: Record<string, WorkflowValue[]>) {
  const result = { ...values };
  for (const [port, items] of Object.entries(values)) {
    if (!inputs[port]?.some(input => input.excludedAssetIds?.length)) continue;
    result[port] = items.map((value, index) => {
      const input = inputs[port]?.[index];
      const excluded = input?.excludedAssetIds;
      if (!excluded?.length) return value;
      const ranks = value.referenceRanks ?? input?.referenceRanks;
      const tokens = new Set(value.imageRefs?.filter(ref => excluded.includes(ref.asset_id)).map(ref => ref.token));
      return { ...value, assetIds: value.assetIds?.filter(id => !excluded.includes(id)),
        referenceRanks: ranks && value.assetIds?.flatMap((id, i) => excluded.includes(id) ? [] : [ranks[i] ?? -1]),
        imageRefs: value.imageRefs?.filter(ref => !excluded.includes(ref.asset_id)),
        text: value.text?.replace(/@图片\d+/g, token => tokens.has(token) ? "" : token) };
    });
  }
  return result;
}

export function disconnectGenerationReference(node: WorkflowNode, values: Record<string, WorkflowValue[]>, assetId: string): Partial<WorkflowNode> {
  node = normalizeWorkflowInputSlots(node);
  const current = filterDisconnectedReferences(node.inputs, values);
  const inputs = { ...node.inputs };
  const promptReferences = [...(node.promptReferences ?? [])];
  const removedRefs = new Set<string>();
  for (const port of ["image", "text"] as const) {
    const bindings = node.inputs[port];
    if (!bindings) continue;
    inputs[port] = [];
    for (const [index, input] of bindings.entries()) {
      const value = current[port]?.[index];
      const ids = value?.assetIds ?? [];
      const sibling = port === "text" && input.autoConnect && node.inputs.image?.some((other, i) =>
        other.autoConnect === input.autoConnect && current.image?.[i]?.assetIds?.includes(assetId) && current.image[i].assetIds!.every(id => id === assetId));
      const removedTokens = value?.imageRefs?.filter(ref => ref.asset_id === assetId).map(ref => ref.token) ?? [];
      const remainingText = value?.text?.replace(/@图片\d+/g, token => removedTokens.includes(token) ? "" : token).trim();
      const remove = !input.dimension && (ids.includes(assetId) || sibling) && !ids.some(id => id !== assetId) && !(port === "text" && remainingText);
      const slot = inputs[port].length + 1;
      for (const [i, ref] of promptReferences.entries()) {
        if (ref.type !== port || ref.direction === "output" || node.promptReferences?.[i].slot !== input.slot) continue;
        if (remove) removedRefs.add(ref.id);
        else promptReferences[i] = { ...ref, slot };
      }
      if (!remove) inputs[port].push(ids.includes(assetId)
        ? { ...input, slot, excludedAssetIds: [...(input.excludedAssetIds ?? []), assetId] }
        : { ...input, slot });
    }
  }
  return { inputs, promptReferences: promptReferences.filter(ref => !removedRefs.has(ref.id)),
    prompt: node.prompt.replace(/@\[([^\]]+)\]/g, (token, id: string) => removedRefs.has(id) ? "" : token) };
}

/** Connected image order determines reference numbers; mentions only place them in the prompt. */
export function generationReferencePreviewOrder(node: WorkflowNode, values: Record<string, WorkflowValue[]>, nodes: readonly WorkflowNode[]) {
  node = rebindGenerationReferences(node);
  values = filterDisconnectedReferences(node.inputs, values);
  const resolved = new Map<string, WorkflowValue>();
  for (const ref of activePromptReferences(node)) {
    const index = node.inputs[ref.type]?.findIndex(input => workflowReferenceMatchesInput(ref, input)) ?? -1;
    const value = values[ref.type]?.[index];
    if (value) resolved.set(ref.id, value);
  }
  const ids = new Set(values.image?.flatMap(value => value.assetIds ?? []) ?? []);
  for (const id of generationMentionAssets(node.prompt, resolved)) ids.add(id);
  for (const type of ["text", "image"] as const) for (const [index, binding] of (node.inputs[type] ?? []).entries()) {
    if (implicitGenerationInput(binding, id => nodes.find(node => node.id === id))) for (const id of values[type]?.[index]?.assetIds ?? []) ids.add(id);
  }
  for (const value of Object.values(values).flat()) for (const id of value.assetIds ?? []) ids.add(id);
  return orderedGenerationReferences(node.inputs, values, [...ids]);
}

export function h3RunReferences(values: Record<string, WorkflowValue[]>, mode: ComfyVideoMode = "frames"): [string[], string[], string[]] {
  const ports = mode === "r2v" ? [H3_R2V_INPUT_PORTS.image, H3_R2V_INPUT_PORTS.video, H3_R2V_INPUT_PORTS.audio]
    : ["first-frame", "last-frame", H3_VIDEO_AUDIO_PORT];
  const ids = (port: string) => (values[port] ?? []).flatMap(value => value.assetIds ?? []);
  return [ids(ports[0]), ids(ports[1]), ids(ports[2])];
}

export function lastGenerationRunInput(document: CanvasWorkflow, nodeId: string): WorkflowStep["generationRunInput"] {
  const runs = workflowRuns(document);
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i], step = run.steps[nodeId];
    if (step?.jobId && step.generationRunInput) return step.generationRunInput;
    const completed = run.loop?.completed;
    if (!completed) continue;
    for (let j = completed.length - 1; j >= 0; j--) {
      const step = completed[j].steps[nodeId];
      if (step?.jobId && step.generationRunInput) return step.generationRunInput;
    }
  }
}

interface GenerationPromptParts {
  references: Record<string, string>;
  context: string;
}

export function renderGenerationDraft(draft: string, parts: GenerationPromptParts) {
  const instruction = draft.replace(/@\[([^\]]+)\]/g, (token, id: string) =>
    Object.prototype.hasOwnProperty.call(parts.references, id) ? parts.references[id] : token);
  return [instruction, parts.context && (instruction.trim() ? `【参考文本】\n${parts.context}` : parts.context)].filter(Boolean).join("\n\n");
}

export function compileGenerationPrompt(node: WorkflowNode, values: Record<string, WorkflowValue[]>, nodes: readonly WorkflowNode[] = [], captureDraft = false) {
  node = rebindGenerationReferences(node);
  const refs = activePromptReferences(node), inputs = generationInputNode(node, nodes).inputs;
  values = filterDisconnectedReferences(inputs, values);
  const resolved = new Map<string, WorkflowValue>();
  for (const ref of refs) {
    const index = (inputs[ref.type] ?? []).findIndex(input => workflowReferenceMatchesInput(ref, input));
    if (index < 0) throw new WorkflowInputError(`「${ref.label}」已断开，请按图片或文本的引用顺序重新连接所需来源，或在提示词中重新选择这处 @ 引用。`, node, ref.input, ref.label);
    const value = values[ref.type]?.[index];
    const dynamic = ref.type === "image" && (ref.slot !== undefined || workflowImageContainer(ref.input));
    if (!value || (ref.assetId && !dynamic && !value.assetIds?.includes(ref.assetId))) throw new WorkflowInputError(`输入管道「${ref.label}」已断开或没有可用输出，请检查当前上游连接`, node, ref.input, ref.label);
    if (ref.type === "text" && !value.text?.trim()) throw new WorkflowInputError(`上游处理结束后，引用「${ref.label}」仍没有可用文本，请检查来源输出`, node, ref.input, ref.label);
    if (dynamic && !value.assetIds?.length) throw new WorkflowInputError(`上游处理结束后，引用「${ref.label}」仍没有可用图片，请检查来源卡片的输出`, node, ref.input, ref.label);
    resolved.set(ref.id, ref.type === "image" && ref.assetId && !dynamic ? { ...value, assetIds: [ref.assetId] } : value);
  }
  const participating = new Set(values.image?.flatMap(value => value.assetIds ?? []) ?? []);
  for (const id of generationMentionAssets(node.prompt, resolved)) participating.add(id);
  // New card-level connections are active without @. Explicit mentions still
  // control placement, so the same source is never appended a second time.
  const automaticText: WorkflowValue[] = [];
  for (const type of ["text", "image"] as const) for (const [index, input] of (inputs[type] ?? []).entries()) {
    if ((type !== "image" && !implicitGenerationInput(input, id => nodes.find(node => node.id === id))) || refs.some(ref => ref.type === type && workflowReferenceMatchesInput(ref, input))) continue;
    const value = values[type]?.[index];
    const label = `${type === "text" ? "文字" : "素材"}输入 ${input.slot ?? index + 1}`;
    if (emptyCompanionPort(type, index, inputs, values)) continue;
    if (!value || (type === "text" ? !value.text?.trim() : !value.assetIds?.length))
      throw new WorkflowInputError(`已连接的${label}没有可用内容，请检查来源输出`, node, input, label);
    for (const id of value.assetIds ?? []) participating.add(id);
    if (type === "text") automaticText.push(value);
  }
  const assetIds = orderedGenerationReferences(inputs, values, [...participating]);
  const renderText = (value: WorkflowValue) => (value.text ?? "").replace(/@图片\d+/g, token => {
    const ref = value.imageRefs?.find(ref => ref.token === token);
    const index = ref ? assetIds.indexOf(ref.asset_id) : -1;
    return index >= 0 ? `@图片${index + 1}` : token;
  });
  const references = Object.fromEntries([...resolved].map(([id, value]) => [id, value.type === "image"
    ? (value.assetIds ?? []).map(assetId => `@图片${assetIds.indexOf(assetId) + 1}`).join(" ") : renderText(value)]));
  const parts = { references, context: automaticText.map(renderText).join("\n\n") };
  const prompt = renderGenerationDraft(node.prompt, parts);
  if (!prompt.trim()) throw new Error("请在生成卡片文本框中填写指令，或通过 @ 引入内容");
  return { prompt, assetIds, ...(captureDraft ? { promptParts: parts } : {}) };
}

/** Keep instructions separate from referenced material, including long reverse prompts. */
export function compileAgentPrompt(node: WorkflowNode, values: Record<string, WorkflowValue[]>, outputTargets: import("./workflowAgentOutputs").AgentOutputTarget[] = []) {
  node = rebindGenerationReferences(node);
  const inputs = generationInputNode(node).inputs;
  const assetIds: string[] = [];
  const sources: Record<string, string | { format: "bowerbird-table"; rows: string[][] }> = {};
  const sourceValue = (value: WorkflowValue, automatic = false) => {
    if (!value.table) {
      if (automatic) for (const id of value.assetIds ?? []) if (!assetIds.includes(id)) assetIds.push(id);
      return value.text!.replace(/@图片\d+/g, token => {
        const ref = value.imageRefs?.find(ref => ref.token === token);
        const index = ref ? assetIds.indexOf(ref.asset_id) : -1;
        return index >= 0 ? `@图片${index + 1}` : token;
      });
    }
    if (!usesConnectedAgentInputs(node) && value.assetIds?.length) throw new WorkflowNodeError("表格包含图片，请使用本机 Agent DS 或 Codex CLI 读取完整图文表格", node);
    // Table image tokens share the same attachment numbering as explicit image inputs.
    if (usesConnectedAgentInputs(node)) for (const id of value.assetIds ?? []) if (!assetIds.includes(id)) assetIds.push(id);
    return { format: "bowerbird-table" as const, rows: contentTableRows(value.table).map(row => row.map(text => text.replace(/@图片\d+/g, token => {
      const ref = value.imageRefs?.find(ref => ref.token === token);
      const index = ref ? assetIds.indexOf(ref.asset_id) : -1;
      return index >= 0 ? `@图片${index + 1}` : token;
    }))) };
  };
  const labels = new Map<string, string>();
  for (const match of node.prompt.matchAll(/@\[([^\]]+)\]/g)) {
    const ref = activePromptReferences(node).find(ref => ref.id === match[1]);
    if (!ref) throw new WorkflowNodeError("Agent 卡片包含无效引用，请重新按 @ 选择文字或图片", node);
    if (labels.has(ref.id)) continue;
    if (ref.direction === "output") {
      const target = outputTargets.find(target => target.writerId === ref.input.nodeId);
      if (!target) throw new WorkflowNodeError(`输出位置「${ref.label}」已断开，请重新按 @ 选择`, node);
      labels.set(ref.id, `输出位置 ${target.id.slice(6)}（${target.id}，${target.type === "image" ? "图片" : "文字"}）`);
      continue;
    }
    const index = (inputs[ref.type] ?? []).findIndex(input => workflowReferenceMatchesInput(ref, input));
    if (index < 0) throw new WorkflowInputError(`输入管道「${ref.label}」已断开，请重新连接上游`, node, ref.input, ref.label);
    const value = values[ref.type]?.[index];
    if (ref.type === "image") {
      const dynamic = ref.slot !== undefined || workflowImageContainer(ref.input);
      const ids = [...new Set(ref.assetId && !dynamic ? [ref.assetId] : value?.assetIds ?? [])];
      if (!ids.length || ids.some(id => !value?.assetIds?.includes(id))) throw new WorkflowInputError(`引用「${ref.label}」没有可用图片，请检查来源输出`, node, ref.input, ref.label);
      for (const id of ids) if (!assetIds.includes(id)) assetIds.push(id);
      labels.set(ref.id, ids.map(id => `图片 ${assetIds.indexOf(id) + 1}`).join("、"));
      continue;
    }
    if (!value?.text?.trim()) throw new WorkflowInputError(`上游处理结束后，引用「${ref.label}」仍没有可用文本，请检查来源输出`, node, ref.input, ref.label);
    const label = `引用文本 ${Object.keys(sources).length + 1}`;
    labels.set(ref.id, label); sources[label] = sourceValue(value, !!inputs[ref.type]?.[index]?.autoConnect);
  }
  {
    for (const type of ["text", "image"] as const) for (const [index, input] of (inputs[type] ?? []).entries()) {
      if (!usesConnectedAgentInputs(node) && !input.autoConnect) continue;
      const value = values[type]?.[index];
      const label = `${type === "text" ? "文字" : "图片"}输入 ${index + 1}`;
      if (emptyCompanionPort(type, index, inputs, values)) continue;
      if (type === "image") {
        if (!value?.assetIds?.length) throw new WorkflowInputError(`已连接的${label}没有可用图片，请检查来源输出`, node, input, label);
        for (const id of value.assetIds) if (!assetIds.includes(id)) assetIds.push(id);
      } else {
        if (!value?.text?.trim()) throw new WorkflowInputError(`已连接的${label}没有可用文字，请检查来源输出`, node, input, label);
        if (input.autoConnect) for (const id of value.assetIds ?? []) if (!assetIds.includes(id)) assetIds.push(id);
        if (!activePromptReferences(node).some(ref => ref.type === type && workflowReferenceMatchesInput(ref, input))) sources[`引用文本 ${Object.keys(sources).length + 1}`] = sourceValue(value, !!input.autoConnect);
      }
    }
  }
  return {
    prompt: node.prompt.replace(/@\[([^\]]+)\]/g, (_, id: string) => `【${labels.get(id)}】`),
    source: JSON.stringify({ ...sources, ...(outputTargets.length ? { __outputTargets: outputTargets.map(target => ({ id: target.id, type: target.type })) } : {}) }),
    assetIds,
  };
}

export function workflowInputValues(nodes: WorkflowNode[], node: WorkflowNode, cellText?: (nodeId: string, cellId: string) => string | WorkflowValue | undefined): Record<string, WorkflowValue[]> {
  const result: Record<string, WorkflowValue[]> = {};
  for (const port of workflowInputs(node)) {
    const media = port.id === H3_VIDEO_AUDIO_PORT || port.id === H3_R2V_INPUT_PORTS.audio ? "录音"
      : port.id === H3_R2V_INPUT_PORTS.video ? "视频" : "图片";
    result[port.id] = (node.inputs[port.id] ?? []).map(input => {
      try {
      if (input.dimension && port.type === "text") return { type: "text", text: input.dimension.body };
      if (input.groupId && port.type === "image") {
        if (!input.assetIds?.length) throw new Error(media === "图片" ? "文件夹中没有可用图片，请添加图片后重新运行" : `文件夹中没有可用${media}`);
        return { type: "image", assetIds: input.assetIds };
      }
      const assetId = workflowInputAssetId(input);
      if (assetId && port.type === "image") return { type: "image", assetIds: [assetId] };
        if (input.canvasNodeId && (port.type === "text" || port.type === "image")) {
        const text = cellText?.(input.canvasNodeId, input.cellId ?? "");
        if (text === undefined) throw new Error("来源卡片或单元格不存在，请检查来源连接");
          const value: WorkflowValue = typeof text === "string" ? { type: "text", text } : text;
          if (value.type !== port.type) throw new Error("连接的单元格类型不匹配，请重新连接");
          // Preserve both slots until compileAgentPrompt can validate the whole wire.
          const otherPort = port.type === "image" ? "text" : "image";
          if ((node.kind === "agent" || node.kind === "generation") && input.autoConnect && node.inputs[otherPort]?.some(
            sibling => sibling.autoConnect === input.autoConnect && sibling.canvasNodeId === input.canvasNodeId,
          )) return value;
          if (value.type === "text" && !value.text?.trim() && !value.nodeIds?.length) throw new Error("来源卡片或单元格中没有可用文本");
          if (value.type === "image" && !value.assetIds?.length && !value.nodeIds?.length) throw new Error(`来源卡片或单元格中没有可用${media}`);
          return value;
      }
      const source = nodes.find(candidate => candidate.id === input.nodeId);
      const stored = source?.outputs[input.portId ?? ""];
      // Legacy async runs kept their exact turns under the old session output.
      const value = source?.kind === "agent" && input.portId === "image" && source.outputs.session?.nodeIds?.length
        ? { ...stored, type: "image" as const, nodeIds: [...new Set([...(stored?.nodeIds ?? []), ...source.outputs.session.nodeIds])] } : stored;
      if (!value || value.type !== port.type) throw new Error(`${port.label}输入尚无有效结果，请先运行上游`);
      return input.videoFrame || input.videoAudio ? { ...value } : value;
      } catch (error) {
        const ref = activePromptReferences(node).find(ref => ref.type === port.type && workflowReferenceMatchesInput(ref, input));
        throw new WorkflowInputError(`${ref ? `@${ref.label}：` : `${port.label}输入：`}${error instanceof Error ? error.message : String(error)}`, node, input, ref?.label);
      }
    });
  }
  const images = result.image?.flatMap(value => value.assetIds ?? []) ?? [];
  if ((result["visual-profile"]?.length ?? 0) > 1) throw new Error("每张卡片只能使用一份视觉规范");
  if (node.kind === "instruction" && !node.inputs.image?.some(input => input.mediaFilter) && !result.image?.some(value => value.nodeIds?.length) && (node.action === "describe" ? images.length < 1 : images.length !== 1)) throw new Error(node.action === "describe" ? "反推需要至少一张输入图片" : "指令卡片需要恰好一张输入图片");
  return result;
}

export function workflowBusy(document: CanvasWorkflow): boolean {
  return workflowRuns(document).some(workflowRunActive);
}
export const workflowRunActive = (run: WorkflowRun) => run.status === "running" || run.status === "waiting";
export const workflowRuns = (document: CanvasWorkflow): WorkflowRun[] => document.runs ?? (document.run ? [document.run] : []);
export function workflowDependencies(nodes: WorkflowNode[], order: string[]): string[] {
  const ids = new Set(order);
  const orderIds = new Set(order), byId = new Map(nodes.map(node => [node.id, node]));
  const inputProducers = indexWorkflowInputProducers(nodes);
  for (const id of ids) {
    const node = byId.get(id);
    if (!node || node.kind === "trigger") continue;
    for (const input of Object.values(workflowExecutionInputs(node)).flat()) {
      if (input.portId === "signal") continue;
      for (const producer of inputProducers(input)) ids.add(producer);
    }
  }
  const tables = new Set(nodes.filter(node => ids.has(node.id) || (node.textTarget && Object.values(node.inputs).flat().some(input => input.portId !== "signal" && orderIds.has(input.nodeId ?? "")))).flatMap(node => [...(node.resultNodeIds ?? []), ...(node.textTarget ? [node.textTarget.nodeId] : [])]));
  for (const node of nodes) if ((node.textTarget && tables.has(node.textTarget.nodeId)) || node.resultNodeIds?.some(id => tables.has(id))) ids.add(node.id);
  return [...ids];
}
export function workflowLockedNodes(document: CanvasWorkflow): Set<string> {
  return new Set(workflowRuns(document).filter(workflowRunActive).flatMap(run => run.lockedNodeIds ?? workflowDependencies(document.nodes, run.order)));
}
/** Execution can rewrite outputs and native result tables; cached dependencies are read-only. */
export function workflowWriteNodes(nodes: WorkflowNode[], order: string[]): string[] {
  const ids = new Set(order);
  const tables = new Set(nodes.filter(node => ids.has(node.id) || (node.textTarget && Object.values(node.inputs).flat().some(input => input.portId !== "signal" && ids.has(input.nodeId ?? "")))).flatMap(node => [...(node.resultNodeIds ?? []), ...(node.textTarget ? [node.textTarget.nodeId] : [])]));
  for (const node of nodes) if ((node.textTarget && tables.has(node.textTarget.nodeId)) || node.resultNodeIds?.some(id => tables.has(id))) ids.add(node.id);
  return [...ids];
}
export function workflowAccessConflict(nodes: WorkflowNode[], readsAndWrites: string[], writes: string[], otherAccess: string[], otherWrites: string[]): boolean {
  const sharedWrites = (left: string[], right: string[]) => left.some(id => right.includes(id) && !nodes.some(node => node.id === id && node.kind === "trigger"));
  return sharedWrites(writes, otherAccess) || sharedWrites(otherWrites, readsAndWrites);
}
export function workflowNodeRun(document: CanvasWorkflow, nodeId: string): WorkflowRun | undefined {
  const runs = workflowRuns(document);
  return runs.find(run => workflowRunActive(run) && run.order.includes(nodeId))
    ?? runs.find(run => workflowRunActive(run) && !run.order.length && run.triggerQueue?.[0] === nodeId)
    ?? runs.find(run => workflowRunActive(run) && run.lockedNodeIds?.includes(nodeId))
    ?? [...runs].reverse().find(run => !workflowRunActive(run) && run.steps[nodeId]);
}
export function workflowActiveSession(node: WorkflowNode): string | null {
  return node.activeSessionNodeId !== undefined ? node.activeSessionNodeId : node.sessionNodeIds?.[node.sessionNodeIds.length - 1] ?? null;
}
export interface H3CardPrompt {
  mode: ComfyVideoMode | "image";
  seconds?: number;
  lastFrameCount?: number;
  source: string;
  result: string;
  original?: string;
  edited?: string;
  paused?: boolean;
  expanded?: boolean;
}

export function isH3ImageCard(node: Pick<WorkflowNode, "kind"> & Partial<Pick<WorkflowNode, "provider" | "generation">>) {
  return node.kind === "generation" && node.provider === H3_IMAGE && node.generation?.media !== "video";
}
export function h3DraftForResult(input: NonNullable<WorkflowStep["comfyOptimization"]>["input"], result: string, original = input.prompt): H3CardPrompt {
  return { ...("mode" in input ? { mode: input.mode, seconds: input.seconds, lastFrameCount: input.lastFrameCount } : { mode: "image" as const }),
    source: input.prompt, result, ...(original === input.prompt ? {} : { original }) };
}
export function h3PromptPatch(draft: H3CardPrompt) {
  return { h3Prompt: draft, prompt: draft.paused ? draft.original ?? draft.source : draft.edited ?? draft.result };
}
export function h3CardDraft(node: WorkflowNode) {
  // An external editor or an older desktop version may have replaced the effective text.
  const draft = node.h3Prompt;
  if (draft && (draft.mode === "image" ? isH3ImageCard(node) : node.kind === "comfy-video")
    && h3PromptPatch(draft).prompt === node.prompt) return draft;
}
export function h3OriginalPrompt(node: WorkflowNode) {
  const draft = h3CardDraft(node);
  return draft?.original ?? draft?.source ?? node.prompt;
}
export function h3DraftStale(node: WorkflowNode, draft: H3CardPrompt) {
  return draft.original !== undefined && draft.original.trim() !== draft.source.trim()
    || node.kind === "comfy-video" && (comfyVideoMode(node.comfyVideo) !== draft.mode
      || draft.seconds !== undefined && (node.comfyVideo ?? DEFAULT_COMFY_VIDEO).seconds !== draft.seconds
      || draft.mode === "frames" && draft.lastFrameCount !== undefined && Number(!!node.inputs["last-frame"]?.length) !== draft.lastFrameCount);
}

export const WORKFLOW_CARD_WIDTH = 320;
export function workflowCardWidth(node: Pick<WorkflowNode, "kind"> & Partial<Pick<WorkflowNode, "provider" | "generation" | "h3Prompt" | "prompt">>) {
  if (node.kind === "comfy-video" || isH3ImageCard(node)) return node.h3Prompt?.expanded && h3PromptPatch(node.h3Prompt).prompt === node.prompt ? 448 : 390;
  return node.kind === "trigger" ? 196 : node.kind === "voice" ? WORKFLOW_CARD_WIDTH * 1.3 : WORKFLOW_CARD_WIDTH;
}
export function workflowPortY(node: WorkflowNode, side: "input" | "output", portId: string): number {
  if (node.kind === "trigger") return node.y + 46;
  const ports = side === "input" ? workflowInputs(node) : workflowOutputs(node);
  // Keep the ports aligned with the compact frame row above the prompt.
  const frameRowOffset = node.kind === "comfy-video" && comfyVideoMode(node.comfyVideo) !== "text" ? 64 : 0;
  return node.y + frameRowOffset + (node.kind === "comfy-video" ? 74 : 94) + Math.max(0, ports.findIndex(port => port.id === portId)) * (node.kind === "comfy-video" ? 24 : 30);
}
