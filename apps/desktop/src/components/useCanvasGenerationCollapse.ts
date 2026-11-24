import { useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from "react";
import type { CanvasPoint, CanvasRect } from "../lib/canvasLogic";
import type { ProjectCanvasUiNode } from "../lib/creativeCanvas";
import type { CanvasNode } from "../lib/types";
import type { workflowGenerationCardProjection, WorkflowGenerationActivity } from "../lib/canvasSessionOutputs";
import type { WorkflowLayerHandle } from "./CanvasWorkflowLayer";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { useLatestCallback } from "../lib/useCanvasFrame";
import { placeCanvasCardNearSource } from "../lib/canvasReferencePlacement";
import { useStore } from "../store";

interface CollapseOptions {
  projectId: string | null;
  projectRouteRevision: number;
  shownGraph: CanvasNode[];
  shownMaterials: ProjectCanvasUiNode[];
  generationCardProjection: Pick<ReturnType<typeof workflowGenerationCardProjection>, "anchors" | "origins">;
  generationActivities: ReadonlyMap<string, WorkflowGenerationActivity>;
  activeGenerationIds: ReadonlySet<string>;
  stageRef: RefObject<HTMLDivElement>;
  planeRef: RefObject<HTMLDivElement>;
  workflowRef: RefObject<WorkflowLayerHandle>;
  selectedCanvasNodeIdsRef: { current: Set<string> };
  setSelectedCanvasNodeIds: Dispatch<SetStateAction<Set<string>>>;
  isStarting(nodeId: string): boolean;
  canStartPeek(): boolean;
  anchorIsDragging(anchorId: string): boolean;
  selectionAnchors(): { id: string; rect: CanvasRect }[];
  revealPinnedCard(position: CanvasRect, imageRect: CanvasRect): void;
  closeQuickRevision(): void;
}

export function useCanvasGenerationCollapse({ projectId, projectRouteRevision, shownGraph, shownMaterials,
  generationCardProjection, generationActivities, activeGenerationIds, stageRef, planeRef, workflowRef, selectedCanvasNodeIdsRef,
  setSelectedCanvasNodeIds, isStarting, canStartPeek, anchorIsDragging, selectionAnchors, revealPinnedCard, closeQuickRevision }: CollapseOptions) {
  const [pinnedWorkflowCards, setPinnedWorkflowCards] = useState<ReadonlyMap<string, CanvasPoint & { attemptId?: string }>>(() => new Map());
  const [peekedCard, setPeekedCard] = useState<{ nodeId: string; anchorId: string } | null>(null);
  const livePeekAnchor = peekedCard && (shownMaterials.find(node => node.id === peekedCard.anchorId)
    ?? shownGraph.find(node => node.id === peekedCard.anchorId));
  const peekInteraction = useRef<{ anchor: HTMLElement; composing: boolean; point?: CanvasPoint; attemptId?: string } | null>(null);
  const peekAnchorPoint = livePeekAnchor ?? (peekedCard && activeGenerationIds.has(peekedCard.nodeId) ? peekInteraction.current?.point : undefined);
  useLayoutEffect(() => {
    if (livePeekAnchor && peekInteraction.current) peekInteraction.current.point = { x: livePeekAnchor.x, y: livePeekAnchor.y };
  }, [livePeekAnchor]);
  const peekIntent = useRef<ReturnType<typeof setTimeout>>();
  const peekClose = useRef<ReturnType<typeof setTimeout>>();
  const clearPeek = useCallback(() => {
    clearTimeout(peekIntent.current);
    clearTimeout(peekClose.current);
    peekInteraction.current = null;
    setPeekedCard(null);
  }, []);
  const newConnectedTextarea = useRef<HTMLTextAreaElement | null>(null);
  const pinnedCardOffsets = useMemo(() => new Map([...pinnedWorkflowCards].filter(([id]) => generationCardProjection.anchors.has(id) || activeGenerationIds.has(id))),
    [pinnedWorkflowCards, generationCardProjection.anchors, activeGenerationIds]);
  const collapsedGenerationAnchors = useMemo(() => new Map([...generationCardProjection.anchors].filter(([id]) => !pinnedCardOffsets.has(id) && !activeGenerationIds.has(id))),
    [generationCardProjection.anchors, pinnedCardOffsets, activeGenerationIds]);
  const lastWorkflowFocus = useRef<{ id: string; element: HTMLElement } | null>(null);
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target !== newConnectedTextarea.current) newConnectedTextarea.current = null;
      const id = target instanceof HTMLElement && stageRef.current?.contains(target)
        ? target.closest<HTMLElement>("[data-workflow-card]")?.dataset.workflowCard : undefined;
      lastWorkflowFocus.current = id && target instanceof HTMLElement ? { id, element: target } : null;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if ([...selectedCanvasNodeIdsRef.current].some(id => collapsedGenerationAnchors.has(id))) {
      setSelectedCanvasNodeIds(current => new Set([...current].map(id => collapsedGenerationAnchors.get(id)?.id ?? id)));
    }
    const previous = lastWorkflowFocus.current;
    const anchor = previous && collapsedGenerationAnchors.get(previous.id);
    if (anchor && previous && !previous.element.isConnected && document.activeElement === document.body) {
      stageRef.current?.querySelector<HTMLElement>(`[data-canvas-node-id="${CSS.escape(anchor.id)}"]`)?.focus({ preventScroll: true });
    }
  }, [collapsedGenerationAnchors]);
  useEffect(() => {
    clearPeek();
    setPinnedWorkflowCards(new Map());
  }, [clearPeek, projectId, projectRouteRevision]);
  useEffect(() => () => {
    clearTimeout(peekIntent.current);
    clearTimeout(peekClose.current);
  }, []);
  useEffect(() => {
    if (!pinnedWorkflowCards.size && !peekedCard) return;
    if (peekedCard && peekInteraction.current) {
      const { nodeId, anchorId } = peekedCard;
      const activity = generationActivities.get(nodeId), interaction = peekInteraction.current;
      if (activity?.running && activity.attemptId) interaction.attemptId = activity.attemptId;
      if (!activeGenerationIds.has(nodeId) && (interaction.attemptId && activity?.terminal && interaction.attemptId === activity.attemptId
        || generationCardProjection.anchors.get(nodeId)?.id !== anchorId)) clearPeek();
    }
    let updated: Map<string, CanvasPoint & { attemptId?: string }> | undefined;
    for (const [id, entry] of pinnedWorkflowCards) {
      const activity = generationActivities.get(id);
      if (!activeGenerationIds.has(id) && (!generationCardProjection.anchors.has(id)
        || entry.attemptId && activity?.terminal && entry.attemptId === activity.attemptId)) {
        (updated ??= new Map(pinnedWorkflowCards)).delete(id);
      } else if (activity?.running && activity.attemptId && entry.attemptId !== activity.attemptId) {
        (updated ??= new Map(pinnedWorkflowCards)).set(id, { ...entry, attemptId: activity.attemptId });
      }
    }
    if (updated) setPinnedWorkflowCards(updated);
  }, [generationCardProjection.anchors, generationActivities, activeGenerationIds, pinnedWorkflowCards, peekedCard, clearPeek]);
  function peekEditor() {
    return planeRef.current?.querySelector<HTMLElement>("[data-workflow-peek]");
  }

  function peekIsLocked(editor = peekEditor()) {
    if (peekedCard && (activeGenerationIds.has(peekedCard.nodeId) || isStarting(peekedCard.nodeId))) return true;
    return !!editor && (editor.matches(':focus-within,[aria-busy="true"]') || !!peekInteraction.current?.composing
      || !!editor.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]'));
  }

  function dismissPeekForDrag(selectedIds: ReadonlySet<string>) {
    if (peekedCard && !selectedIds.has(peekedCard.anchorId) && !peekIsLocked()) clearPeek();
  }

  function peekAnchorIsDragging() {
    if (!peekedCard) return false;
    const anchorId = peekedCard.anchorId;
    return anchorIsDragging(anchorId);
  }

  const closePeekAfterLeave = useLatestCallback(() => {
    clearTimeout(peekClose.current);
    const interaction = peekInteraction.current;
    if (!interaction || peekIsLocked() || peekAnchorIsDragging()) return;
    peekClose.current = setTimeout(() => {
      const editor = peekEditor();
      if (peekInteraction.current === interaction && !peekIsLocked(editor) && !peekAnchorIsDragging()
        && !interaction.anchor.matches(":hover") && !editor?.matches(":hover")) clearPeek();
    }, 220);
  });

  const openPeek = useLatestCallback((anchorId: string, anchor: HTMLElement) => {
    if (!canStartPeek() || !anchor.isConnected || !anchor.matches(":hover") || peekIsLocked()) return;
    const origin = generationCardProjection.origins.get(anchorId);
    if (!origin || generationCardProjection.anchors.get(origin.id)?.id !== anchorId || pinnedCardOffsets.has(origin.id)
      || activeGenerationIds.has(origin.id) || isStarting(origin.id)) return;
    clearTimeout(peekClose.current);
    peekInteraction.current = { anchor, composing: false };
    setPeekedCard({ nodeId: origin.id, anchorId });
  });

  function startPeek(event: PointerEvent<HTMLElement>, anchorId: string) {
    if (event.pointerType === "touch" || event.buttons !== 0 || !canStartPeek()) {
      clearTimeout(peekIntent.current);
      return;
    }
    if (peekedCard?.anchorId === anchorId) { clearTimeout(peekClose.current); return; }
    if (!generationCardProjection.origins.has(anchorId)) return;
    clearTimeout(peekIntent.current);
    const anchor = event.currentTarget;
    peekIntent.current = setTimeout(() => openPeek(anchorId, anchor), 160);
  }

  function leavePeekAnchor() {
    clearTimeout(peekIntent.current);
    closePeekAfterLeave();
  }

  const onPeekInteraction = useLatestCallback((kind: "enter" | "leave" | "blur" | "compose" | "commit") => {
    if (kind === "enter") { clearTimeout(peekClose.current); return; }
    const interaction = peekInteraction.current;
    if (!interaction) return;
    if (kind === "compose") { interaction.composing = true; return; }
    if (kind === "commit") interaction.composing = false;
    if (kind === "blur") queueMicrotask(closePeekAfterLeave);
    else closePeekAfterLeave();
  });

  function unpinGenerationCard(nodeId: string) {
    setPinnedWorkflowCards(current => {
      if (!current.has(nodeId)) return current;
      const next = new Map(current);
      next.delete(nodeId);
      return next;
    });
    const anchor = generationCardProjection.anchors.get(nodeId);
    if (anchor) {
      setSelectedCanvasNodeIds(current => current.has(nodeId) ? new Set([...current].filter(id => id !== nodeId).concat(anchor.id)) : current);
      requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>(`[data-canvas-node-id="${CSS.escape(anchor.id)}"]`)?.focus({ preventScroll: true }));
    }
  }

  function focusPinnedGenerationPrompt(nodeId: string, newConnectionPrompt = false) {
    const stage = stageRef.current;
    const revision = useStore.getState().projectRouteRevision;
    requestAnimationFrame(() => {
      const route = useStore.getState();
      if (!stage?.isConnected || stageRef.current !== stage || !isWorkspaceOperationCurrent(projectId, route.activeProjectId,
        route.projectRoutePending, revision, route.projectRouteRevision)) return;
      const card = stage.querySelector<HTMLElement>(`[data-workflow-card="${CSS.escape(nodeId)}"]`);
      const prompt = card?.querySelector<HTMLElement>('[aria-label="卡片指令"]:is([contenteditable="true"],textarea:not(:disabled))');
      if (!prompt) return;
      if (newConnectionPrompt && prompt instanceof HTMLTextAreaElement) {
        newConnectedTextarea.current = prompt;
        // Native text undo consumes its own keystroke after keydown, so only a fresh untouched field can fall back here.
        prompt.addEventListener("input", () => {
          if (newConnectedTextarea.current === prompt) newConnectedTextarea.current = null;
        }, { once: true });
      }
      prompt.focus({ preventScroll: true });
    });
  }

  function pinGenerationCard(nodeId: string, connectedAnchorId?: string) {
    const anchor = generationCardProjection.anchors.get(nodeId);
    const card = workflowRef.current?.bounds(true).find(item => item.id === nodeId);
    if (!anchor || !card) return;
    if (connectedAnchorId && (anchor.id !== connectedAnchorId || activeGenerationIds.has(nodeId) || isStarting(nodeId))) return;
    if (peekedCard?.nodeId === nodeId && peekAnchorPoint && peekInteraction.current) {
      const { x, y } = peekAnchorPoint;
      const { attemptId } = peekInteraction.current;
      setPinnedWorkflowCards(current => new Map(current).set(nodeId,
        { x: x - card.width - 12 - card.x, y: y - card.y, attemptId }));
      clearPeek();
      if (connectedAnchorId) {
        setSelectedCanvasNodeIds(new Set([nodeId]));
        focusPinnedGenerationPrompt(nodeId);
      }
      return;
    }
    const anchors = selectionAnchors();
    const imageRect = anchors.find(item => item.id === anchor.id)?.rect ?? anchor;
    const visible = pinnedCardOffsets.has(nodeId) && anchors.find(item => item.id === nodeId)?.rect;
    const leftOfMedia = { ...card, x: imageRect.x - card.width - 12, y: imageRect.y };
    const position = visible || (connectedAnchorId ? leftOfMedia : placeCanvasCardNearSource(leftOfMedia,
      anchors.filter(item => item.id !== card.id).map(item => item.rect)));
    setPinnedWorkflowCards(current => current.has(nodeId) ? current : new Map(current).set(nodeId,
      { x: position.x - card.x, y: position.y - card.y }));
    closeQuickRevision();
    setSelectedCanvasNodeIds(new Set([nodeId]));
    revealPinnedCard({ ...card, ...position }, imageRect);
    const stage = stageRef.current;
    const mountingForConnection = !!connectedAnchorId && !stage?.querySelector(`[data-workflow-card="${CSS.escape(nodeId)}"]`);
    focusPinnedGenerationPrompt(nodeId, mountingForConnection);
  }

  const toggleGenerationPin = useLatestCallback((nodeId: string) => {
    if (pinnedCardOffsets.has(nodeId)) unpinGenerationCard(nodeId);
    else pinGenerationCard(nodeId);
  });
  const pinConnectedGeneration = useLatestCallback((nodeId: string, anchorId: string) => pinGenerationCard(nodeId, anchorId));

  const peekCard = useMemo(() => peekedCard && peekAnchorPoint ? { ...peekedCard, point: peekAnchorPoint } : undefined,
    [peekedCard, peekAnchorPoint]);
  return { peekCard, pinnedCardOffsets, collapsedGenerationAnchors, newConnectedTextarea, peekIntent,
    startPeek, leavePeekAnchor, dismissPeekForDrag, closePeekAfterLeave, onPeekInteraction, pinGenerationCard,
    toggleGenerationPin, pinConnectedGeneration };
}
