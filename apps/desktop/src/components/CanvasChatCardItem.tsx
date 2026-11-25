import { memo, type MouseEvent } from "react";
import { CANVAS_DRAG_Z_LIFT } from "../lib/canvasDragPreview";
import { localChatRunning, type ChatSummary } from "../lib/localChat";
import type { CanvasNode } from "../lib/types";
import { LocalChatCard } from "./LocalChatPanel";
import type { CanvasGraphCardHandlers } from "./CanvasNoteCardItem";

export const CanvasChatCardItem = memo(function CanvasChatCardItem({
  node, chatId, chat, selected, focused, lifted, handlers, onClick, onOpen,
}: {
  node: CanvasNode;
  chatId: string;
  chat?: ChatSummary;
  selected: boolean;
  focused: boolean;
  lifted: boolean;
  handlers: CanvasGraphCardHandlers;
  onClick: (event: MouseEvent<HTMLElement>, chatId: string) => void;
  onOpen: (chatId: string) => void;
}) {
  const running = localChatRunning(chat);
  return <div data-canvas-node data-canvas-node-id={node.id} data-local-chat-id={chatId}
    role="button" tabIndex={0} aria-label={`对话 · ${chat?.title ?? "正在读取"}`} aria-busy={running}
    className={`canvas-chat-node${selected ? " is-selected" : ""}${focused ? " is-focused" : ""}${running ? " canvas-card-running" : ""}`}
    style={{ width: node.width, minHeight: node.height, transform: `translate3d(${node.x}px, ${node.y}px, 0)`, zIndex: lifted ? CANVAS_DRAG_Z_LIFT + node.zIndex : node.zIndex }}
    onPointerDown={event => handlers.onDragStart(event, node)} onPointerMove={handlers.onDragMove}
    onPointerUp={handlers.onDragEnd} onPointerCancel={event => handlers.onDragEnd(event, true)}
    onContextMenu={event => handlers.onMenu(event, node.id)}
    onClick={event => onClick(event, chatId)}
    onKeyDown={event => {
      if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); onOpen(chatId); }
    }}>
    {chat ? <LocalChatCard conversation={chat} /> : <div className="local-chat-card-content"><strong>对话</strong><p>打开对话详情</p></div>}
  </div>;
});
