import { type ChatCardDefaults } from "../lib/localChat";
import type { canvasConversationCards } from "../lib/canvasConversationCards";
import { useCallback } from "react";
import { Clapperboard, Images, List, Palette, Repeat2, Sparkles, Timer, Workflow, MousePointer2, CalendarClock, CheckCheck } from "lucide-react";
import { comfyVideoMode, DEFAULT_COMFY_VIDEO } from "../lib/comfyVideo";
import { type AutomaticOutput } from "../lib/workflowAutoConnect";
import { type WorkflowGenerationActivity } from "../lib/canvasSessionOutputs";
import { workflowDisconnectId, workflowBindingKey } from "../lib/canvasWorkflow";
import { type CanvasWorkflow, type WorkflowInput, type WorkflowKind, type WorkflowNode, type WorkflowPort } from "../lib/canvasWorkflow";
import type { CanvasNode } from "../lib/types";
import { ComfyEnvironmentControl, type ComfyEnvironmentState } from "./ComfyVideoCard";
import { AudioLines } from "lucide-react";

function AgentCardIcon({ size }: { size: number }) {
  return <svg className="agent-card-icon" xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 1024 1024">
    <path fill="#1296db" d="M788.96 795.208c3.288-1.72 6.536-3.504 9.76-5.344 8.144-5.104 16.528-9.944 24.408-15.44A319.936 319.936 0 0 0 960 512c0-176.728-143.272-320-320-320H384C207.272 192 64 335.272 64 512s143.408 316.936 320 324c100 4 112 4 192-4v80l72.944-40L672 859.36 788.96 795.2zM225.616 670.4q-32.8-32.8-49.88-75.936Q160 554.72 160 512q0-42.72 15.728-82.456 17.072-43.128 49.88-75.936 32.8-32.8 75.936-49.88Q341.28 288 420 288h200q42.72 0 102.456 15.728 43.128 17.072 75.936 49.88 32.8 32.8 49.88 75.936Q864 469.28 864 512q0 55.424-25.84 104.448C802.056 684.936 664.688 746.944 600 782.416V736c-95.96 14.928-205.128 21.216-298.456-15.728Q258.416 703.2 225.608 670.4zM440 420v120a36 36 0 1 0 72 0v-120a36 36 0 1 0-72 0z m224 0v120a36 36 0 1 0 72 0v-120a36 36 0 1 0-72 0z" />
  </svg>;
}

export const WORKFLOW_CARD_PRESENTATION = {
  instruction: { icon: List, code: "CMD", title: "指令处理" },
  generation: { icon: Images, code: "GEN", title: "图片生成" },
  agent: { icon: AgentCardIcon, code: "AGT", title: "Agent" },
  loop: { icon: Repeat2, code: "LOOP", title: "循环处理" },
  "visual-profile": { icon: Palette, code: "VIS", title: "视觉规范" },
  trigger: { icon: Timer, code: "TRG", title: "触发器" },
  director3d: { icon: Clapperboard, code: "3D", title: "3D 导演台" },
  voice: { icon: AudioLines, code: "VOX", title: "角色声音" },
  "comfy-video": { icon: Clapperboard, code: "VID", title: "视频生成" },
  skill: { icon: Sparkles, code: "MOD", title: "技能卡片" },
  planner: { icon: Sparkles, code: "MOD", title: "工作流助手" },
  text: { icon: Workflow, code: "MOD", title: "工作流" },
};
export const NEW_AGENT_CHAT_TOOLTIP = "在新建对话中运行指令，消除上下文影响";

export type DisconnectTarget = { nodeId: string; port?: string; cellId?: string; wireKey?: string };
export const disconnectKey = (node: WorkflowNode, port: string, binding: WorkflowInput) =>
  workflowDisconnectId(binding) ?? JSON.stringify([node.id, port, workflowBindingKey(binding)]);

export function comfyCheckKey(node: WorkflowNode) {
  return JSON.stringify([node.id, node.comfyVideo?.endpoint ?? DEFAULT_COMFY_VIDEO.endpoint, comfyVideoMode(node.comfyVideo)]);
}

export type H3RunChoice = "optimize" | "original" | "previous";
export function CardComfyEnvironment({ node, disabled, onChange, onStatus }: {
  node: WorkflowNode; disabled: boolean; onChange: (changes: Partial<WorkflowNode>) => void;
  onStatus: (key: string, message: string | null) => void;
}) {
  const key = comfyCheckKey(node);
  const report = useCallback((result: ComfyEnvironmentState) => onStatus(key, result.ready ? null : result.message), [key, onStatus]);
  return <ComfyEnvironmentControl node={node} disabled={disabled} onChange={onChange} onStatusChange={report} />;
}
export const TRIGGER_MODES = [
  { id: "manual", label: "手动点击", icon: MousePointer2 },
  { id: "daily", label: "每天定时", icon: CalendarClock },
  { id: "once", label: "一次定时", icon: Timer },
  { id: "completion", label: "上游完成", icon: CheckCheck },
] as const;

export function WindingKey({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 10C9 2 2 4 3 8s6 5 9 2Zm0 0c3-8 10-6 9-2s-6 5-9 2ZM12 10v10m-3 0h6m-3-4h3" />
  </svg>;
}
export interface WorkflowGeometry { id: string; x: number; y: number; width: number; height: number }
export interface WorkflowLayerHandle {
  bindRecording: (nodeId: string, assetId: string, assetNodeId?: string) => boolean;
  startLocalVideo: (request: import("../lib/comfyVideo").ComposerLocalVideoRequest, point: { x: number; y: number }) => Promise<void>;
  templates: (importPackage?: boolean) => void;
  saveTemplate: (ids: string[], mode?: "template" | "package" | "container") => void;
  inputText: (nodeId: string, cellId?: string, disconnect?: boolean, type?: "text" | "image" | "auto", point?: { x: number; y: number }, keyboard?: boolean) => void;
  connectSelection: (nodeIds: string[], clientX: number, clientY: number, keyboard?: boolean) => void;
  connectCell: (nodeId: string, cellId: string, clientX: number, clientY: number, keyboard?: boolean) => void;
  openCardMenu: (x: number, y: number, point: { x: number; y: number }) => void;
  add: (kind: WorkflowKind, x: number, y: number) => void; arm: (x?: number, y?: number) => void;
  cancelPlacement: () => void;
  bounds: (includeHidden?: boolean) => WorkflowGeometry[];
  createImageCard: (sourceId: string, assetId: string, point: { x: number; y: number }) => void;
  position: (positions: ReadonlyMap<string, { x: number; y: number }>, persist?: boolean) => void;
  isLocked: (id: string) => boolean;
  isConnecting: () => boolean;
}
export interface MaterialAnchor { id: string; assetId?: string; video?: boolean; audio?: boolean; groupId?: string; assetIds?: string[]; mediaAssetIds?: string[]; x: number; y: number; width: number; height: number }
export interface WorkflowLayerProps {
  provisional?: boolean;
  diagnosticTarget?: HTMLElement | null;
  getZoom: () => number;
  opening: boolean;
  entryCardIds: ReadonlySet<string> | null;
  deferredCandidateIds: ReadonlySet<string> | null;
  graphNodes: CanvasNode[];
  visibleGraphNodeIds?: ReadonlySet<string>;
  conversationCards?: ReturnType<typeof canvasConversationCards>;
  selectedConversationOutputs?: ReadonlyMap<string, { id: string; video: boolean }>;
  imageOnlyConversationIds?: ReadonlySet<string>;
  sessionHeights?: ReadonlyMap<string, number>;
  generationCardAnchors?: ReadonlyMap<string, CanvasNode>;
  generationCardOrigins: ReadonlyMap<string, WorkflowNode>;
  generationActivities: ReadonlyMap<string, WorkflowGenerationActivity>;
  activeGenerationIds: ReadonlySet<string>;
  pinnedCardOffsets?: ReadonlyMap<string, { x: number; y: number }>;
  peekCard?: { nodeId: string; anchorId: string; point: { x: number; y: number } };
  onPeekInteraction?: (kind: "enter" | "leave" | "blur" | "compose" | "commit") => void;
  onToggleGenerationPin?: (nodeId: string) => void;
  onConnectCollapsedGeneration: (nodeId: string, anchorId: string) => void;
  onUndoGenerationConnection: (nodeId: string) => boolean;
  selectedIds: Set<string>;
  panReady: boolean;
  onSelect: (id: string, additive?: boolean) => void;
  onNodesChanged: () => void;
  onEdited: (before: CanvasWorkflow, after: CanvasWorkflow, connectedGenerationId?: string) => void;
  onOpenGeneration: (node: CanvasNode) => void;
  getChatCardDefaults?: () => ChatCardDefaults;
  onOpenAgent: (nodeId: string, conversationId?: string, entryKey?: string, applyPrompt?: (text: string) => Promise<void>) => void;
  onNewAgentChat?: (previousId: string) => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>, node: WorkflowNode) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: React.PointerEvent<HTMLElement>, cancelled?: boolean) => void;
  onNodeMenu: (event: React.MouseEvent<HTMLElement>, id: string) => void;
  onRemove: (id: string) => void;
  projectId: string; zoom?: number; materials: MaterialAnchor[];
  ensureMaterialized: () => Promise<unknown>;
  toBoardPoint: (clientX: number, clientY: number) => { x: number; y: number };
  onPlaced: (rect: { x: number; y: number; width: number; height: number }) => void;
}
export type Connection = WorkflowInput & { type: WorkflowPort["type"] };
export type AutomaticTarget = { nodeId?: string; canvasNodeId?: string; cellId?: string; collapsedAnchorId?: string };
export type PendingConnectionCard = {
  projectId: string; node: WorkflowNode; inputs: WorkflowNode["inputs"]; target: AutomaticTarget; connectionId: string;
};
export type AutomaticGesture = { id: string; side: "input" | "output"; outputs: AutomaticOutput[]; target: AutomaticTarget;
  start: { x: number; y: number }; dragged: boolean; latest?: boolean; scope?: string; trigger?: HTMLElement | null;
  completion?: { pointerId: number; anchor: { x: number; y: number } } };
export type VideoReferencePosition = NonNullable<WorkflowInput["videoFrame"]>["position"];
export const VIDEO_REFERENCE_OPTIONS = [
  { label: "引用完整视频", frame: undefined },
  { label: "引用首帧画面", frame: "first" },
  { label: "引用尾帧画面", frame: "last" },
] as const;
export type VideoReferenceTarget = { output: AutomaticOutput; target: AutomaticTarget; created?: WorkflowNode };
export type ConnectionMenuState = { gesture: AutomaticGesture; x: number; y: number; video?: VideoReferenceTarget };

export function singleVideoOutput(outputs: AutomaticOutput[]) {
  const [output] = outputs;
  return outputs.length === 1 && !output.selectionWireId && (output.binding.assetId || output.binding.nodeId && output.binding.portId)
    && (output.media === "video" || Array.isArray(output.media) && output.media.length === 1 && output.media[0] === "video")
    ? output : undefined;
}
export const CONNECTION_CARDS: { label: string; kind: WorkflowKind; media?: "image" | "video"; action?: WorkflowNode["action"] }[] = [
  { label: "图片生成", kind: "generation", media: "image" }, { label: "视频生成", kind: "generation", media: "video" },
  { label: "图片反推", kind: "instruction", action: "describe" }, { label: "复用提示词", kind: "instruction", action: "reuse" },
  { label: "分层拆分", kind: "instruction", action: "layers" }, { label: "Agent", kind: "agent" },
  { label: "视觉规范", kind: "visual-profile" }, { label: "角色声音", kind: "voice" },
];
export function connectionForType(source: Connection, type?: WorkflowPort["type"]): Connection {
  return ["*latest", "*latest-image"].includes(source.cellId ?? "") && (type === "text" || type === "image")
    ? { ...source, cellId: type === "image" ? "*latest-image" : "*latest", type } : source;
}
