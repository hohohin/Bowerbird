import type { canvasConversationCards } from "../lib/canvasConversationCards";
import type { WorkflowGenerationActivity } from "../lib/canvasSessionOutputs";
import type { CanvasWorkflow, WorkflowKind, WorkflowNode } from "../lib/canvasWorkflow";
import type { ChatCardDefaults } from "../lib/localChat";
import type { CanvasNode } from "../lib/types";
import type { useStore } from "../store";

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
  settledZoom?: number;
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
export type DisconnectTarget = { nodeId: string; port?: string; cellId?: string; wireKey?: string };
export type H3RunChoice = "optimize" | "original" | "previous";
export type WorkflowLayerStore = Pick<ReturnType<typeof useStore.getState>, "visualProfiles" | "activeGenProvider" | "defaultProvider" | "codexHealth" | "dreaminaHealth" | "cloudAuth" | "cloudEntitlement" | "openVisualProfile">;
