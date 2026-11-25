import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { CanvasPoint } from "../../lib/canvasLogic";
import type { ProjectCanvasUiNode } from "../../lib/creativeCanvas";
import type { CanvasEdge, CanvasNode } from "../../lib/types";
import { workflowCardWidth, type WorkflowNode } from "../../lib/canvasWorkflow";
import { isAudioPath } from "../../lib/audioMedia";
import { isVideoPath } from "../../lib/videoGeneration";
import { isTextPath } from "../../lib/textMedia";
import { useLatestCallback } from "../../lib/useCanvasFrame";
import { useStore } from "../../store";

export const ENTRY_LIGHT_CARD_LIMIT = 48;
const ENTRY_MIN_BATCH_WEIGHT = 24;
const ENTRY_HEAVY_CARD_WEIGHT = 6;
const ENTRY_FRAME_BUDGET_MS = 16;
export const EMPTY_ENTRY_CARDS: ReadonlySet<string> = new Set();

export function afterCanvasPaint(run: () => void) {
  let timer: number | undefined;
  const frame = requestAnimationFrame(() => { timer = window.setTimeout(run, 0); });
  return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
}

type MountedCards = ReadonlySet<string> | null;

interface CanvasEntryInputs {
  stageRef: RefObject<HTMLDivElement>;
  entryCandidates: MutableRefObject<MountedCards>;
  prioritizeEntry: MutableRefObject<((pan: CanvasPoint, zoom: number) => void) | undefined>;
  inputDuringEntry: MutableRefObject<number>;
  entryCardIdsRef: RefObject<MountedCards>;
  entryCommitAt: MutableRefObject<number>;
  panRef: MutableRefObject<CanvasPoint>;
  zoomRef: MutableRefObject<number>;
  loadTokenRef: RefObject<number>;
  graphNodes: CanvasNode[];
  promptGraphNodes: CanvasNode[];
  agentGraphNodes: CanvasNode[];
  chatGraphNodes: CanvasNode[];
  visibleMaterials: ProjectCanvasUiNode[];
  workflowNodes: WorkflowNode[];
  graphEdges: CanvasEdge[];
  projectId: string | null;
  projectRouteRevision: number;
  projectRoutePending: boolean;
  loading: boolean;
  loadFailed: boolean;
  workflowSettled: boolean;
  entryViewportReady: boolean;
  hasActiveGesture: () => boolean;
  setEntryViewportReady: Dispatch<SetStateAction<boolean>>;
  setEntryCardIds: Dispatch<SetStateAction<MountedCards>>;
}

export function useCanvasEntryScheduler({
  stageRef, entryCandidates, prioritizeEntry, inputDuringEntry, entryCardIdsRef, entryCommitAt, panRef, zoomRef,
  loadTokenRef, graphNodes, promptGraphNodes, agentGraphNodes, chatGraphNodes, visibleMaterials, workflowNodes,
  graphEdges, projectId, projectRouteRevision, projectRoutePending, loading, loadFailed, workflowSettled,
  entryViewportReady, hasActiveGesture, setEntryViewportReady, setEntryCardIds,
}: CanvasEntryInputs) {
  const startEntryMount = useLatestCallback(() => {
    const mounted = entryCardIdsRef.current;
    if (!mounted || !projectId) return;
    const token = loadTokenRef.current;
    const stage = stageRef.current;
    const candidates = new Map([
      ...[...graphNodes.filter(node => node.kind === "note" && node.hiddenAt == null), ...promptGraphNodes, ...agentGraphNodes, ...chatGraphNodes]
        .map(node => ({ ...node, weight: ENTRY_HEAVY_CARD_WEIGHT })),
      ...visibleMaterials.map(node => ({ ...node,
        weight: node.kind === "asset" && !isVideoPath(node.asset.storePath) && !isAudioPath(node.asset.storePath) && !isTextPath(node.asset.storePath) ? 1 : ENTRY_HEAVY_CARD_WEIGHT })),
      ...workflowNodes.filter(node => node.kind !== "text").map(node => ({ ...node, width: workflowCardWidth(node), height: 330, weight: ENTRY_HEAVY_CARD_WEIGHT })),
    ].map(card => [card.id, card]));
    const wires: Array<[string, string]> = graphEdges.map(edge => [edge.fromNodeId, edge.toNodeId]);
    for (const node of workflowNodes) {
      const target = node.textTarget?.nodeId ?? node.textSource ?? node.id;
      for (const binding of Object.values(node.inputs).flat()) {
        const source = binding.canvasNodeId ?? binding.assetNodeId ?? binding.nodeId ?? binding.groupId;
        if (source) wires.push([source, target]);
      }
    }
    entryCandidates.current = new Set(candidates.keys());
    let committed = new Set(mounted);
    let remaining = new Set([...candidates.keys()].filter(id => !committed.has(id)));
    let nearby: string[] = [];
    let lastView: { x: number; y: number; zoom: number; width: number; height: number } | undefined;
    let initialViewReady = entryViewportReady;
    let expected: ReadonlySet<string> | null = mounted;
    let lastCommitted: ReadonlySet<string> | null = mounted;
    let active = true;
    let cancelBatch: (() => void) | undefined;
    let resume: number | undefined;
    let idle: number | undefined;
    let batchBudget = ENTRY_LIGHT_CARD_LIMIT;
    let batchStarted: number | undefined;
    let viewportBatchCommitted = mounted.size > 0;
    let width = stage?.clientWidth ?? 0;
    let height = stage?.clientHeight ?? 0;
    function priority(pan: CanvasPoint, zoom: number) {
      if (lastView?.x === pan.x && lastView.y === pan.y && lastView.zoom === zoom
        && lastView.width === width && lastView.height === height) return;
      lastView = { ...pan, zoom, width, height };
      const buffer = 200;
      const inView = new Set([...remaining].filter(id => {
        const card = candidates.get(id)!;
        return pan.x + card.x * zoom <= width + buffer && pan.x + (card.x + card.width) * zoom >= -buffer
          && pan.y + card.y * zoom <= height + buffer && pan.y + (card.y + card.height) * zoom >= -buffer;
      }));
      // A wire can cross the viewport even when its two cards are outside it.
      for (const [fromId, toId] of wires) {
        const from = candidates.get(fromId), to = candidates.get(toId);
        if (!from || !to || (!remaining.has(fromId) && !remaining.has(toId))) continue;
        const left = Math.min(from.x, to.x), right = Math.max(from.x + from.width, to.x + to.width);
        const bend = Math.max(50, (right - left) * .45);
        if (pan.x + (left - bend) * zoom > width + buffer || pan.x + (right + bend) * zoom < -buffer
          || pan.y + Math.min(from.y, to.y) * zoom > height + buffer
          || pan.y + Math.max(from.y + from.height, to.y + to.height) * zoom < -buffer) continue;
        if (remaining.has(fromId)) inView.add(fromId);
        if (remaining.has(toId)) inView.add(toId);
      }
      const distanceToViewportStart = (id: string) => {
        const card = candidates.get(id)!;
        const x = pan.x + card.x * zoom, y = pan.y + card.y * zoom;
        const intersects = x <= width && x + card.width * zoom >= 0 && y <= height && y + card.height * zoom >= 0;
        return (intersects ? 0 : width + height) + Math.max(0, x) + Math.max(0, y);
      };
      nearby = [...inView].sort((a, b) => distanceToViewportStart(a) - distanceToViewportStart(b));
      if (nearby.length && (resume !== undefined || idle !== undefined)) {
        window.clearTimeout(resume);
        resume = undefined;
        if (idle !== undefined) window.cancelIdleCallback(idle);
        idle = undefined;
        cancelBatch?.();
        cancelBatch = afterCanvasPaint(mountBatch);
      }
    }
    function scheduleBatch() {
      if (initialViewReady && nearby.length === 0) {
        // Offscreen cards can wait until input has settled and the browser is idle.
        resume = window.setTimeout(() => {
          resume = undefined;
          if (typeof window.requestIdleCallback !== "function") { mountBatch(); return; }
          idle = window.requestIdleCallback(() => { idle = undefined; mountBatch(); }, { timeout: 250 });
        }, 100);
      } else cancelBatch = afterCanvasPaint(mountBatch);
    }
    function mountBatch() {
      const route = useStore.getState();
      if (!active || loadTokenRef.current !== token || route.projectRoutePending
        || route.activeProjectId !== projectId || route.projectRouteRevision !== projectRouteRevision) return;
      const current = entryCardIdsRef.current;
      if (current !== expected) {
        if (current === lastCommitted) {
          scheduleBatch();
          return;
        }
        if (!current) return;
        // Workflow readiness can restart the scheduler while the preceding
        // transition is already committing. Continue from the painted set.
        expected = current;
        committed = new Set(current);
        remaining = new Set([...candidates.keys()].filter(id => !committed.has(id)));
        batchStarted = undefined;
        lastView = undefined;
        priority(panRef.current, zoomRef.current);
      }
      lastCommitted = current;
      if (initialViewReady && hasActiveGesture()) {
        scheduleBatch();
        return;
      }
      if (initialViewReady && !nearby.length && performance.now() - inputDuringEntry.current < 650) {
        scheduleBatch();
        return;
      }
      if (batchStarted !== undefined) {
        viewportBatchCommitted = true;
        const elapsed = entryCommitAt.current - batchStarted;
        if (elapsed > ENTRY_FRAME_BUDGET_MS) batchBudget = Math.max(ENTRY_MIN_BATCH_WEIGHT, Math.floor(batchBudget * .75));
        else if (elapsed < ENTRY_FRAME_BUDGET_MS / 2) batchBudget = Math.min(ENTRY_LIGHT_CARD_LIMIT, batchBudget + ENTRY_HEAVY_CARD_WEIGHT);
        batchStarted = undefined;
      }
      const ids: string[] = [];
      let weight = 0;
      const prioritized = nearby.length > 0;
      for (const id of prioritized ? nearby : initialViewReady ? remaining : []) {
        const cost = candidates.get(id)!.weight;
        if (ids.length > 0 && weight + cost > batchBudget) break;
        ids.push(id);
        weight += cost;
      }
      if (prioritized) nearby.splice(0, ids.length);
      for (const id of ids) { committed.add(id); remaining.delete(id); }
      // The first viewport batch makes the shell interactive. Neighboring
      // cards and their wires continue to mount before the offscreen queue.
      const ready = !initialViewReady && (viewportBatchCommitted || nearby.length === 0);
      const done = workflowSettled && remaining.size === 0;
      if (ready) {
        initialViewReady = true;
        inputDuringEntry.current = performance.now();
      }
      const next = done ? null : ids.length ? new Set(committed) : expected;
      if (ids.length) batchStarted = performance.now();
      expected = next;
      // The paint scheduler already yields between small commits. A transition
      // here can keep a background batch pending behind live workspace updates.
      if (ready || done) setEntryViewportReady(previous => active ? true : previous);
      if (next !== current) setEntryCardIds(previous => active && previous === current ? next : previous);
      if (done) {
        prioritizeEntry.current = undefined;
        resize.disconnect();
      } else if (remaining.size && (initialViewReady || nearby.length)) scheduleBatch();
    }
    prioritizeEntry.current = priority;
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      priority(panRef.current, zoomRef.current);
    });
    if (stage) resize.observe(stage);
    priority(panRef.current, zoomRef.current);
    cancelBatch = afterCanvasPaint(mountBatch);
    return () => {
      active = false;
      prioritizeEntry.current = undefined;
      resize.disconnect();
      cancelBatch?.();
      window.clearTimeout(resume);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  });
  useEffect(() => {
    if (loading || loadFailed || projectRoutePending) return;
    return startEntryMount();
  }, [loading, loadFailed, projectId, projectRouteRevision, projectRoutePending, startEntryMount, workflowSettled]);
}
