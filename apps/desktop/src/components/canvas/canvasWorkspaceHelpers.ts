import type { CanvasToolboxTool } from "../CanvasToolbox";
import type { WorkflowInput, WorkflowKind, WorkflowNode } from "../../lib/canvasWorkflow";
import { countCloudAgentResultImages } from "../../lib/cloudAgentResult";
import { canvasAssetNodeSize, type CanvasAssetSnapshot, type ProjectCanvasUiNode } from "../../lib/creativeCanvas";
import type { CanvasNode as ProjectGraphNode, GenJob, Project, ProjectTitleSource } from "../../lib/types";
import type { useStore } from "../../store";

export const ASSET_WIDTH = 190;

export const DEFAULT_TITLE = "未命名创作";

export type CanvasNode = ProjectCanvasUiNode;
export type CanvasAssetNode = Extract<CanvasNode, { kind: "asset" }>;
export type CanvasFolderNode = Extract<CanvasNode, { kind: "folder" }>;

export type CanvasTool = "select" | "pan" | "section" | "artboard" | "bubble" | "document" | Exclude<WorkflowKind, "trigger">;
export type CanvasToolbarTool = CanvasTool | CanvasToolboxTool | "trigger" | "templates";

/** Board geometry and results depend on job identity, live preview and saved turns. */
export function sameCanvasGenerationJob(before: GenJob | undefined | null, next: GenJob | undefined | null) {
  return before === next || !!before && !!next
    && before.id === next.id && before.projectId === next.projectId && before.conversationId === next.conversationId
    && before.running === next.running && before.preview === next.preview && before.turns === next.turns
    && before.provider === next.provider && before.media === next.media && before.videoOptions === next.videoOptions
    && before.lastPrompt === next.lastPrompt;
}

export const workflowToolsAllowed = ({ cloudAuth, cloudEntitlement }: ReturnType<typeof useStore.getState>) =>
  cloudAuth?.logged_in === true && !!cloudAuth.user_id && cloudEntitlement?.user_id === cloudAuth.user_id
  && (cloudEntitlement.tier === "pro" || cloudEntitlement.tier === "studio")
  && (cloudEntitlement.offline_state === "fresh" || cloudEntitlement.offline_state === "grace");
const freeCanvasTools = new Set<CanvasToolbarTool>(["select", "pan", "section", "artboard", "document", "text", "bubble", "generation", "replication", "video-to-doc"]);
export function isToolbarToolLocked(tool: CanvasToolbarTool, pro: boolean, localVideoAllowed: boolean) {
  return tool === "comfy-video" ? !localVideoAllowed : !pro && !freeCanvasTools.has(tool);
}

export interface ActiveCanvasState {
  id: string;
  title: string;
  titleSource: ProjectTitleSource;
  draftJson: string;
  materialized: boolean;
}

export function canvasId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function provisionalCanvas(project: Project | null): ActiveCanvasState {
  return {
    id: project?.id ?? "",
    title: project?.name ?? DEFAULT_TITLE,
    titleSource: project?.title_source ?? "default",
    draftJson: JSON.stringify({ schema_version: 1 }),
    materialized: !!project && !project.provisional,
  };
}

export function activeFromProject(
  project: Project,
  draftJson: string,
): ActiveCanvasState {
  return {
    id: project.id,
    title: project.name,
    titleSource: project.title_source ?? "default",
    draftJson,
    materialized: true,
  };
}

export function assetNodeSize(asset: CanvasAssetSnapshot) {
  return canvasAssetNodeSize(asset, ASSET_WIDTH);
}

export function baseNodeRect(node: { x: number; y: number; width: number; height: number; kind?: string }, showAssetNames: boolean | undefined) {
  // Stored asset geometry includes its caption, independent of this display preference.
  const caption = node.kind === "asset" && !showAssetNames ? 30 : 0;
  return { x: node.x, y: node.y, width: node.width, height: node.height - caption };
}

export function containedNodeIds(nodes: CanvasNode[]) {
  return new Set(nodes.flatMap((node) => node.kind === "asset"
    ? [node.asset.id]
    : node.assets.map((asset) => asset.id)));
}

export function isCanvasRedoShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  return (event.ctrlKey || event.metaKey) && (event.shiftKey ? key === "z" : !event.metaKey && key === "y");
}

export function workflowReferencesTo(node: WorkflowNode, ids: Set<string>) {
  const targetsBatch = (id: string | undefined) => !!id && ids.has(id);
  const isBinding = (input: WorkflowInput) => [input.nodeId, input.canvasNodeId, input.assetNodeId, input.groupId].some(targetsBatch);
  return new Set([
    ...(targetsBatch(node.textSource) ? [JSON.stringify(["textSource", node.textSource])] : []),
    ...(targetsBatch(node.textTarget?.nodeId) ? [JSON.stringify(["textTarget", node.textTarget])] : []),
    ...(node.resultNodeIds ?? []).filter(targetsBatch).map(id => JSON.stringify(["result", id])),
    ...Object.entries(node.inputs).flatMap(([port, inputs]) => inputs.filter(isBinding).map(input => JSON.stringify([port, input]))),
  ]);
}

export function uniqueSnapshots(assets: CanvasAssetSnapshot[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}

export function groupedAssetNode(asset: CanvasAssetSnapshot, group: CanvasFolderNode, index: number): CanvasAssetNode {
  const size = assetNodeSize(asset);
  return {
    kind: "asset",
    id: asset.id,
    asset,
    x: group.x + (index % 2) * 22,
    y: group.y + Math.floor(index / 2) * 22,
    width: size.width,
    height: size.height,
    order: group.order + index + 1,
  };
}

export function promptNodeSummary(node: ProjectGraphNode) {
  try {
    const payload = JSON.parse(node.payloadJson) as {
      job_id?: string;
      turn_key?: string;
      text?: string;
      provider?: string;
      status?: string;
    };
    return {
      jobId: payload.job_id ?? "",
      turnKey: payload.turn_key ?? "",
      text: payload.text?.trim() || "生成指令",
      provider: payload.provider ?? "provider",
      status: payload.status ?? "saved",
    };
  } catch {
    return { jobId: "", turnKey: "", text: "生成指令", provider: "provider", status: "saved" };
  }
}

export function agentGroupSummary(node: ProjectGraphNode) {
  try {
    const payload = JSON.parse(node.payloadJson) as {
      run_id?: string;
      skill_id?: string;
      status?: string;
      current_step?: string;
      progress?: number;
      approvals?: Array<{ status?: string }>;
      clarifications?: Array<{ status?: string }>;
      artifacts?: Array<{ role?: string; mime?: string; user_visible?: boolean }>;
    };
    return {
      runId: payload.run_id ?? "",
      skill: payload.skill_id ?? "Bowerbird Agent",
      status: payload.status ?? "created",
      currentStep: payload.current_step ?? null,
      progress: payload.progress ?? null,
      pendingApprovals: payload.approvals?.filter((item) => item.status === "pending").length ?? 0,
      pendingClarifications: payload.clarifications?.filter((item) => item.status === "pending").length ?? 0,
      artifactCount: countCloudAgentResultImages(payload.artifacts ?? []),
    };
  } catch {
    return {
      runId: "",
      skill: "Bowerbird Agent",
      status: "unknown",
      currentStep: null,
      progress: null,
      pendingApprovals: 0,
      pendingClarifications: 0,
      artifactCount: 0,
    };
  }
}

export function canvasGeometryDiffers(
  before: { x: number; y: number; width: number; height: number },
  after: { x: number; y: number; width: number; height: number } | undefined,
) {
  if (!after) return false;
  return before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height;
}
