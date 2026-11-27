import { Archive, ArchiveRestore, LayoutDashboard, List, LoaderCircle, Magnet, Maximize2, Minus, Plus, Redo2, Undo2 } from "lucide-react";
import type { RefObject } from "react";
import { TacticalSelect } from "../TacticalSelect";
import { notifyError } from "../../lib/notify";
import type { CreativeThread, CreativeViewMode, ProjectTimelineScope } from "../../lib/types";
import type { useImeGuard } from "../../lib/useImeGuard";
import { userErrorMessage } from "../../lib/userError";
import { useStore } from "../../store";
import type { ActiveCanvasState } from "./canvasWorkspaceHelpers";

interface CanvasWorkspaceHeaderProps {
  activeCanvas: Pick<ActiveCanvasState, "id" | "title">;
  activeCanvasRef: { readonly current: ActiveCanvasState };
  replaceActive: (draft: ActiveCanvasState) => void;
  commitProjectTitle: () => void;
  titleIme: ReturnType<typeof useImeGuard>;
  viewMode: CreativeViewMode;
  boardOpen: boolean;
  genEditing: string | null;
  selectedCanvasNodeIds: ReadonlySet<string>;
  opening: boolean;
  savingVisible: boolean;
  loading: boolean;
  currentWorkflowEntry: { error: string | null; retry: () => void } | null;
  workflow: { readonly ready: boolean; readonly error: string | null } | null;
  error: string | null;
  writeFailed: boolean;
  retryPendingWrites: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoCanvasAction: () => boolean;
  redoCanvasAction: () => boolean;
  snapEnabled: boolean;
  toggleCanvasSnap: () => void;
  threads: CreativeThread[];
  timelineScope: ProjectTimelineScope;
  focusedThreadId: string | null;
  setProjectTimelineScope: (scope: ProjectTimelineScope) => void;
  setFocusedThreadId: (threadId: string) => void;
  markViewDirty: () => void;
  focusedThreadIsArchived: boolean;
  toggleFocusedThreadArchive: () => Promise<void>;
  selectViewMode: (mode: CreativeViewMode) => void;
  stageRef: RefObject<HTMLDivElement>;
  zoomRef: { readonly current: number };
  zoomLabelRef: RefObject<HTMLSpanElement>;
  zoomAround: (clientX: number, clientY: number, requested: number) => void;
  fitCanvas: () => void;
  resetCanvasZoom: () => void;
}

export function CanvasWorkspaceHeader({
  activeCanvas, activeCanvasRef, replaceActive, commitProjectTitle, titleIme,
  viewMode, boardOpen, genEditing, selectedCanvasNodeIds, opening, savingVisible, loading,
  currentWorkflowEntry, workflow, error, writeFailed, retryPendingWrites,
  canUndo, canRedo, undoCanvasAction, redoCanvasAction, snapEnabled, toggleCanvasSnap,
  threads, timelineScope, focusedThreadId, setProjectTimelineScope, setFocusedThreadId, markViewDirty,
  focusedThreadIsArchived, toggleFocusedThreadArchive, selectViewMode, stageRef, zoomRef, zoomLabelRef, zoomAround, fitCanvas, resetCanvasZoom,
}: CanvasWorkspaceHeaderProps) {
  return (
    <div className="canvas-board-toolbar">
      <div>
        <span className="canvas-board-title-field" data-title={activeCanvas.title || " "}>
          <input
            className="canvas-board-title"
            aria-label="项目名称"
            title="点击重命名项目"
            value={activeCanvas.title}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              const draft = activeCanvasRef.current;
              draft.title = event.target.value;
              draft.titleSource = "manual";
              replaceActive(draft);
            }}
            onBlur={commitProjectTitle}
            onCompositionStart={titleIme.onCompositionStart}
            onCompositionEnd={titleIme.onCompositionEnd}
            onKeyDown={(event) => {
              if (titleIme.isComposing(event.nativeEvent)) { event.stopPropagation(); return; }
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </span>
        <small>
          {viewMode === "canvas"
            ? boardOpen || genEditing
              ? "创作模式 · 点击素材加入创作"
              : "浏览模式 · 双指移动 / 空格 + 左键 / 中键 平移"
            : "项目内创作线程的顺序投影"}
        </small>
        {selectedCanvasNodeIds.size > 0 && (
          <small className="canvas-selection-count">
            已选择 {selectedCanvasNodeIds.size} 项 · 拖动可整体移动
          </small>
        )}
        <small className={`canvas-save-state${!opening && savingVisible ? " is-visible" : ""}`} aria-hidden={opening || !savingVisible}>
          <LoaderCircle size={12} /> 保存中
        </small>
        {!loading && currentWorkflowEntry?.error !== null && (currentWorkflowEntry?.error
          ? <small className="canvas-save-error" role="alert">工作流加载失败
              <button type="button" className="ml-2 underline" onClick={currentWorkflowEntry.retry}>{workflow?.ready && workflow.error ? "重试保存工作流" : "重新加载工作流"}</button></small>
          : <small className="canvas-save-state is-visible" role="status">正在加载工作流…</small>)}
        {error && <small className="canvas-save-error" title={userErrorMessage(error, "画板未能保存，请重试保存。")}>保存失败，修改仍保留在当前画面
          {writeFailed && <button type="button" className="ml-2 underline" onClick={() => { void retryPendingWrites().catch(error => notifyError(error, "画板保存失败")); }}>重试保存画板</button>}
        </small>}
      </div>
      <div className="canvas-zoom-controls" role="toolbar" aria-label="画板控制">
        <button type="button" title="撤销（Ctrl / ⌘ Z）" aria-label="撤销画布操作" disabled={viewMode !== "canvas" || !canUndo}
          onPointerDown={event => event.preventDefault()} onClick={undoCanvasAction}><Undo2 size={14} /></button>
        <button type="button" title="重做（Ctrl / ⌘ Shift Z）" aria-label="重做画布操作" disabled={viewMode !== "canvas" || !canRedo}
          onPointerDown={event => event.preventDefault()} onClick={redoCanvasAction}><Redo2 size={14} /></button>
        <button type="button" title="磁吸 N" aria-label="吸附对齐" aria-keyshortcuts="N" data-canvas-control="snap"
          disabled={viewMode !== "canvas"} aria-pressed={snapEnabled} onClick={toggleCanvasSnap}><Magnet size={14} /></button>
        <span className="canvas-toolbar-divider" aria-hidden="true" />
        {viewMode === "timeline" && threads.length > 0 && (
          <TacticalSelect
            aria-label="时间线范围"
            value={timelineScope === "all" ? "__all" : focusedThreadId ?? "__all"}
            onValueChange={(value) => {
              if (value === "__all") {
                setProjectTimelineScope("all");
              } else {
                setFocusedThreadId(value);
                setProjectTimelineScope("focused");
                useStore.getState().clearProjectThreadUnread(activeCanvas.id, value);
              }
              markViewDirty();
            }}
          >
            <option value="__all">项目全部活动</option>
            <optgroup label="进行中的线程">
              {threads.filter((thread) => thread.archivedAt == null).map((thread) => (
                <option key={thread.id} value={thread.id}>{thread.title}</option>
              ))}
            </optgroup>
            {threads.some((thread) => thread.archivedAt != null) && (
              <optgroup label="已归档（选择后可恢复）">
                {threads.filter((thread) => thread.archivedAt != null).map((thread) => (
                  <option key={thread.id} value={thread.id}>{thread.title}</option>
                ))}
              </optgroup>
            )}
          </TacticalSelect>
        )}
        {viewMode === "timeline" && timelineScope === "focused" && focusedThreadId && threads.some((thread) => thread.id === focusedThreadId) && (
          <button
            type="button"
            title={focusedThreadIsArchived ? "恢复当前线程" : "归档当前线程"}
            aria-label={focusedThreadIsArchived ? "恢复当前线程" : "归档当前线程"}
            onClick={() => void toggleFocusedThreadArchive()}
          >
            {focusedThreadIsArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
        )}
        <button
          type="button"
          className={viewMode === "canvas" ? "is-active" : ""}
          title="画板视图"
          aria-label="画板视图"
          aria-pressed={viewMode === "canvas"}
          onClick={() => selectViewMode("canvas")}
        >
          <LayoutDashboard size={14} />
        </button>
        <button
          type="button"
          className={viewMode === "timeline" ? "is-active" : ""}
          title="时间线视图"
          aria-label="时间线视图"
          aria-pressed={viewMode === "timeline"}
          onClick={() => selectViewMode("timeline")}
        >
          <List size={14} />
        </button>
        <span className="canvas-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          title="缩小"
          aria-label="缩小"
          disabled={viewMode !== "canvas"}
          onClick={() => {
            const rect = stageRef.current?.getBoundingClientRect();
            if (rect) zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current - 0.15);
          }}
        >
          <Minus size={14} />
        </button>
        <button type="button" title="重置缩放到 100%（Shift+0）" aria-label="重置缩放到 100%" aria-keyshortcuts="Shift+0"
          disabled={viewMode !== "canvas"} onClick={resetCanvasZoom} style={{ width: 44, fontSize: 10 }}>
          <span ref={zoomLabelRef}>{Math.round(zoomRef.current * 100)}%</span>
        </button>
        <button
          type="button"
          title="放大"
          aria-label="放大"
          disabled={viewMode !== "canvas"}
          onClick={() => {
            const rect = stageRef.current?.getBoundingClientRect();
            if (rect) zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current + 0.15);
          }}
        >
          <Plus size={14} />
        </button>
        <button type="button" title="适应内容（Shift+1），适应选中项（Shift+2）" aria-label="适应内容" aria-keyshortcuts="Shift+1" disabled={viewMode !== "canvas"} onClick={fitCanvas}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function CanvasWorkspaceLoadFailure({
  error,
  onRetry,
  onExit,
}: {
  error: string | null;
  onRetry: () => void;
  onExit?: () => void;
}) {
  return (
    <div className="canvas-load-failure" role="alert">
      <div className="canvas-load-failure-card">
        <span className="panel-kicker">项目画板</span>
        <h2>未能载入项目</h2>
        <p>为避免把暂时读取失败误当成空画板，编辑功能已暂停。原项目数据没有被覆盖。</p>
        {error && <p>{userErrorMessage(error, "画板暂时无法加载，请重新打开项目。")}</p>}
        <div>
          <button type="button" className="app-button-primary" onClick={onRetry}>
            重试载入
          </button>
          {onExit && (
            <button type="button" className="app-button-secondary" onClick={onExit}>
              返回主页
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
