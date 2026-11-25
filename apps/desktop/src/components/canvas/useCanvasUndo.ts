import { useRef, useState } from "react";
import type { ProjectCanvasUiNode as CanvasNode } from "../../lib/creativeCanvas";
import type { CanvasGroup, CanvasNode as ProjectGraphNode } from "../../lib/types";
import type { GalleryMerge } from "../../lib/generationGallery";
import type { WorkflowEditUndo } from "../../lib/workflowUndo";
import type { WorkflowGeometry } from "../CanvasWorkflowLayer";
import { useLatestCallback } from "../../lib/useCanvasFrame";

export type CanvasUndoEntry =
  | { kind: "gallery"; projectId: string; edit: GalleryMerge }
  | { kind: "names"; projectId: string; before: Record<string, string | undefined> }
  | { kind: "content"; projectId: string; before: ProjectGraphNode; after: ProjectGraphNode; typedAt?: number; restoredMaterials?: CanvasNode[] }
  | { kind: "materials"; projectId: string; before: CanvasNode[]; after: CanvasNode[]; groups: Map<string, CanvasGroup> }
  | { kind: "workflow"; projectId: string; edit: WorkflowEditUndo; connectedGenerationId?: string }
  | { kind: "paste"; projectId: string; nodeIds: string[]; groupIds: string[]; workflowIds: string[] }
  | { kind: "removal"; changedFolders?: Extract<CanvasNode, { kind: "folder" }>[]; projectId: string; materials: CanvasNode[]; graph: ProjectGraphNode[]; groups: Map<string, CanvasGroup>; workflow?: WorkflowEditUndo | null }
  | { kind: "geometry"; projectId: string; materials: CanvasNode[]; graph: ProjectGraphNode[]; workflow: WorkflowGeometry[] };

export function useCanvasUndo(
  prepareUndo: () => string,
  applyCanvasUndo: (entry: CanvasUndoEntry) => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const undoHistoryRef = useRef<CanvasUndoEntry[]>([]);
  const undoInFlightRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);

  function pushCanvasUndo(entry: CanvasUndoEntry) {
    const history = undoHistoryRef.current;
    history.push(entry);
    if (history.length > 80) history.shift();
    setCanUndo(true);
  }
  function popCanvasUndo() {
    const entry = undoHistoryRef.current.pop();
    setCanUndo(undoHistoryRef.current.length > 0);
    return entry;
  }
  function removeUndoEntry(entry: CanvasUndoEntry) {
    const history = undoHistoryRef.current;
    const index = history.indexOf(entry);
    if (index >= 0) {
      history.splice(index, 1);
      setCanUndo(history.length > 0);
    }
  }
  function clearCanvasUndo() {
    undoHistoryRef.current = [];
    setCanUndo(false);
  }
  const undoCanvasAction = useLatestCallback(() => {
    if (undoInFlightRef.current) return false;
    const projectId = prepareUndo();
    const entry = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (!entry || entry.projectId !== projectId) return false;
    undoInFlightRef.current = true;
    void applyCanvasUndo(entry).catch(reportError).finally(() => { undoInFlightRef.current = false; });
    return true;
  });
  return { undoHistoryRef, canUndo, pushCanvasUndo, popCanvasUndo, removeUndoEntry, clearCanvasUndo, undoCanvasAction };
}
