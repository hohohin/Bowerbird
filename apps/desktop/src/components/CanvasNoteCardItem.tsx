import { memo, useMemo, type CSSProperties, type ComponentProps, type MouseEvent, type PointerEvent } from "react";
import { GripHorizontal, Sparkles } from "lucide-react";
import { shallow } from "zustand/shallow";
import { CANVAS_DRAG_Z_LIFT } from "../lib/canvasDragPreview";
import { canvasCellValue, canvasDocumentHeight, canvasTextMinSize, readCanvasNote, type CanvasNotePayload } from "../lib/canvasNotes";
import { resolveGenerationCells } from "../lib/canvasSessionOutputs";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import type { Asset, CanvasNode } from "../lib/types";
import { CanvasDocumentCard } from "./CanvasDocumentCard";
import { CanvasImage } from "./CanvasImage";
import { CanvasResizeHandle } from "./CanvasResizeHandle";
import { CanvasTextCard } from "./CanvasTextCard";

type TextCardProps = ComponentProps<typeof CanvasTextCard>;

export interface CanvasGraphCardHandlers {
  onDragStart: (event: PointerEvent<HTMLElement>, node: CanvasNode) => void;
  onDragMove: (event: PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: PointerEvent<HTMLElement>, cancelled?: boolean) => void;
  onMenu: (event: MouseEvent<HTMLElement>, nodeId: string) => void;
}

export interface CanvasNoteCardHandlers extends CanvasGraphCardHandlers {
  getZoom: () => number;
  hideOriginal: NonNullable<TextCardProps["hideOriginal"]>;
  onOpenPreview: NonNullable<TextCardProps["onOpenPreview"]>;
  readCurrentValue: (savedNode: CanvasNode, value: CanvasNotePayload) => CanvasNotePayload;
  onOpenDocument: (node: CanvasNode, value: CanvasNotePayload) => void;
  onOpenArtboard: (node: CanvasNode) => void;
  onMediaContextMenu: (event: MouseEvent<HTMLElement>, node: CanvasNode, asset: Asset) => void;
  onOpenGeneration: NonNullable<TextCardProps["onOpenGeneration"]>;
  renderGeneration: (node: CanvasNode, cell: Parameters<NonNullable<TextCardProps["renderGeneration"]>>[0]) => ReturnType<NonNullable<TextCardProps["renderGeneration"]>>;
  onConnect: (nodeId: string, ...args: Parameters<NonNullable<TextCardProps["onConnectCell"]>>) => void;
  onInput: (nodeId: string, ...args: Parameters<NonNullable<TextCardProps["onInput"]>>) => void;
  onChange: (nodeId: string, ...args: Parameters<TextCardProps["onChange"]>) => void;
  onResize: (nodeId: string, ...args: Parameters<ComponentProps<typeof CanvasResizeHandle>["onResize"]>) => void;
  onSelect: (nodeId: string) => void;
}

interface CanvasNoteCardProps {
  savedNode: CanvasNode;
  generationNodes?: readonly CanvasNode[];
  generationRevision?: object;
  selected: boolean;
  lifted: boolean;
  editing: boolean;
  workflowInteractive: boolean;
  inputLocked?: boolean;
  writerFailures?: readonly string[];
  assetById: ReadonlyMap<string, Asset>;
  loadReferenceAssets: NonNullable<TextCardProps["loadReferenceAssets"]>;
  handlers: CanvasNoteCardHandlers;
}

type NoteSource = { value: CanvasNotePayload; assetIds?: ReadonlySet<string> };
const noteSources = new WeakMap<CanvasNode, NoteSource>();
function noteSource(node: CanvasNode): NoteSource {
  const cached = noteSources.get(node);
  if (cached) return cached;
  const source = { value: readCanvasNote(node) };
  noteSources.set(node, source);
  return source;
}

function noteSourceAssetIds(node: CanvasNode) {
  const source = noteSource(node);
  if (source.assetIds) return source.assetIds;
  const { value } = source;
  const assetIds = new Set<string>();
  for (const row of value.cells) for (const cell of row) {
    for (const id of canvasCellValue(cell).assetIds) assetIds.add(id);
  }
  if (value.artboard?.base_asset_id) assetIds.add(value.artboard.base_asset_id);
  source.assetIds = assetIds;
  return assetIds;
}

function sameNoteCard(before: CanvasNoteCardProps, next: CanvasNoteCardProps) {
  const { savedNode, assetById, loadReferenceAssets, ...presentation } = before;
  const { savedNode: nextNode, assetById: nextAssets, loadReferenceAssets: nextLoader, ...nextPresentation } = next;
  if (!shallow(savedNode, nextNode) || !shallow(presentation, nextPresentation)) return false;
  if (assetById === nextAssets && loadReferenceAssets === nextLoader) return true;
  if (before.generationNodes) return false;
  // Native refreshes replace the graph and asset index even when this note and
  // its references are unchanged. Only unresolved references need a new loader.
  for (const id of noteSourceAssetIds(savedNode)) {
    const asset = assetById.get(id), nextAsset = nextAssets.get(id);
    if (asset !== nextAsset || !asset && loadReferenceAssets !== nextLoader) return false;
  }
  return true;
}

export const CanvasNoteCardItem = memo(function CanvasNoteCardItem({
  savedNode, generationNodes, generationRevision, selected, lifted, editing, workflowInteractive, inputLocked,
  writerFailures, assetById, loadReferenceAssets, handlers,
}: CanvasNoteCardProps) {
  const source = useMemo(() => noteSource(savedNode).value, [savedNode.payloadJson]);
  const value = useMemo(() => generationNodes ? resolveGenerationCells(source, generationNodes) : source, [source, generationNodes]);
  const minimum = useMemo(() => value.note_type === "text" || value.note_type === "images" ? canvasTextMinSize(value.cells) : null, [value]);
  const node = {
    ...savedNode,
    width: Math.max(savedNode.width, minimum?.width ?? 0),
    height: value.note_type === "document" ? canvasDocumentHeight(savedNode.width) : Math.max(savedNode.height, minimum?.height ?? 0),
  };
  const section = value.note_type === "section";
  const plainSection = section && !value.artboard && !value.workflow_container;
  const baseId = value.artboard?.base_asset_id;
  const base = baseId ? assetById.get(baseId) : undefined;
  const openDocument = () => handlers.onOpenDocument(node, value);
  const connect: TextCardProps["onConnectCell"] = !workflowInteractive ? undefined : (id, x, y, keyboard) => handlers.onConnect(node.id, id, x, y, keyboard);
  const resize: TextCardProps["onResize"] = (size, finished, cancelled) => handlers.onResize(node.id, size, finished, cancelled);

  return <div data-canvas-node data-canvas-node-id={node.id} data-workflow-container={value.workflow_container ? node.id : undefined} tabIndex={0}
    className={`canvas-note ${section ? "is-section" : value.note_type === "bubble" ? "is-bubble" : "is-text is-content-card"} ${value.note_type === "document" ? "is-document-card" : ""} ${value.artboard ? "is-artboard" : ""} ${selected ? "is-selected" : ""} ${writerFailures?.length ? "canvas-card-error" : ""}`}
    style={{ "--section-color": value.section_color, width: node.width, height: node.height,
      ...(plainSection ? { left: node.x, top: node.y } : { transform: `translate3d(${node.x}px, ${node.y}px, 0)`, zIndex: section ? 0 : lifted ? CANVAS_DRAG_Z_LIFT + node.zIndex : node.zIndex }) } as CSSProperties & { "--section-color"?: string }}
    onPointerDown={event => handlers.onDragStart(event, node)} onPointerMove={handlers.onDragMove}
    onPointerUp={handlers.onDragEnd} onPointerCancel={event => handlers.onDragEnd(event, true)}
    onLostPointerCapture={event => handlers.onDragEnd(event, true)}
    onContextMenu={event => handlers.onMenu(event, node.id)}
    onDoubleClick={value.note_type === "document" ? event => { if ((event.target as Element).closest("button")) return; event.stopPropagation(); openDocument(); } : undefined}>
    {!!writerFailures?.length && <button type="button" className="canvas-note-dismiss-error"
      onPointerDown={event => event.stopPropagation()} onClick={event => {
        event.stopPropagation(); writerFailures.forEach(key => canvasWorkflowController(node.projectId).dismissCardFailure(key));
      }}>关闭错误提示</button>}
    {section ? <>
      {baseId && base?.store_path && !handlers.hideOriginal(baseId, base.store_path) && <CanvasImage className="canvas-artboard-base" data-frequent-asset-id={baseId} draggable={false}
        path={base.store_path} sourceWidth={base.width} sourceHeight={base.height} alt="画板基底" />}
      <div className="canvas-section-heading" title={value.artboard ? "拖动画板" : "拖动分区"}><GripHorizontal size={17} />
        {value.workflow_container && <span className="canvas-workflow-container-badge">封装 · {value.member_ids.length}</span>}
      </div>
      {value.artboard && <button type="button" className="canvas-artboard-compose" style={node.width < 300 ? { bottom: "calc(100% + 36px)" } : undefined} onPointerDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); handlers.onOpenArtboard(node); }}><Sparkles size={14} />合成画板中的内容</button>}
      {["top", "bottom", "left", "right"].map(edge => <div key={edge} className={`canvas-section-edge ${edge}`} />)}
      {selected && !value.workflow_container && ([["nw", "左上角"], ["ne", "右上角"], ["sw", "左下角"], ["se", "右下角"]] as const).map(([corner, label]) => (
        <CanvasResizeHandle key={corner} label={`调整${value.artboard ? "画板" : "分区"}大小（${label}）`} corner={corner} size={node} position={{ x: node.x, y: node.y }} zoom={1} getZoom={handlers.getZoom}
          minimum={{ width: 120, height: 80 }} onResize={resize} />
      ))}
    </> : value.note_type === "document" ? <CanvasDocumentCard value={value} editing={editing} onEdit={openDocument} onConnect={connect} />
    : <CanvasTextCard value={value} hideOriginal={handlers.hideOriginal} selected={selected} width={node.width} height={node.height} getZoom={handlers.getZoom}
      assetById={assetById} loadReferenceAssets={loadReferenceAssets}
      readCurrentValue={() => handlers.readCurrentValue(savedNode, value)}
      onOpenPreview={handlers.onOpenPreview}
      onMediaContextMenu={(event, asset) => handlers.onMediaContextMenu(event, node, asset)}
      onOpenGeneration={handlers.onOpenGeneration}
      renderGeneration={generationRevision ? cell => handlers.renderGeneration(node, cell) : undefined}
      onConnectCell={connect} onInput={!workflowInteractive ? undefined : (...args) => handlers.onInput(node.id, ...args)} inputLocked={inputLocked}
      onResize={resize} onSelect={() => handlers.onSelect(node.id)}
      onChange={(next, size, history) => handlers.onChange(node.id, next, size, history)} />}
  </div>;
}, sameNoteCard);
