import type { CanvasNotePayload } from "../lib/canvasNotes";
import { userErrorMessage } from "../lib/userError";
import { ContextMenu, ContextSubmenu } from "./ContextMenu";
import { WORKFLOW_CARD_PRESENTATION } from "./WorkflowLayerPresentation";
import type { WorkflowKind, WorkflowNode } from "../lib/canvasWorkflow";

export type VideoReferenceMode = "first" | "last" | "audio";
export const VIDEO_REFERENCE_OPTIONS = [
  { label: "引用完整视频", mode: undefined },
  { label: "引用首帧画面", mode: "first" },
  { label: "引用尾帧画面", mode: "last" },
  { label: "引用视频音频", mode: "audio" },
] as const;

export interface ConnectionCardOption {
  label: string;
  kind: WorkflowKind;
  media?: "image" | "video";
  action?: WorkflowNode["action"];
}

export const IMAGE_GENERATION_CARD: ConnectionCardOption = { label: "图片生成", kind: "generation", media: "image" };
const CONNECTION_CARDS: ConnectionCardOption[] = [
  IMAGE_GENERATION_CARD, { label: "视频生成", kind: "generation", media: "video" },
  { label: "图片反推", kind: "instruction", action: "describe" }, { label: "复用提示词", kind: "instruction", action: "reuse" },
  { label: "分层拆分", kind: "instruction", action: "layers" }, { label: "Agent", kind: "agent" },
  { label: "视觉规范", kind: "visual-profile" }, { label: "角色声音", kind: "voice" },
];

export function WorkflowConnectionMenu({ x, y, direction, trigger, video, onClose, newCardError, createCard, existingCards, note }: {
  x: number;
  y: number;
  direction?: "input" | "output";
  trigger?: HTMLElement | null;
  video?: { error: (mode?: VideoReferenceMode) => string | null; choose: (mode?: VideoReferenceMode) => void };
  onClose: () => void;
  newCardError?: (option: ConnectionCardOption) => string | null;
  createCard: (option: ConnectionCardOption) => void;
  existingCards?: () => { id: string; label: string; choose: (rect: DOMRect) => void }[];
  note?: { cells: CanvasNotePayload["cells"]; selectScope: (cellId?: string) => void; latest?: boolean; toggleLatest: () => void };
}) {
  return <ContextMenu x={x} y={y}
    label={video ? "引用视频" : direction === "output" ? "添加下游" : direction === "input" ? "添加上游" : "新建卡片"}
    trigger={video ? trigger : undefined} onClose={onClose}>
    {video ? VIDEO_REFERENCE_OPTIONS.map(({ label, mode }) => {
      const error = video.error(mode);
      return <button key={label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={!!error} title={error ?? undefined}
        onClick={() => video.choose(mode)}>{label}</button>;
    }) : <>
      {CONNECTION_CARDS.map(option => {
        const error = newCardError?.(option);
        const Icon = WORKFLOW_CARD_PRESENTATION[option.kind].icon;
        return <button key={option.label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={!!error}
          title={error ? userErrorMessage(error, "此卡片暂时不能连接") : undefined} onClick={() => createCard(option)}>
          <Icon size={15} />{option.label}
        </button>;
      })}
      {existingCards && <ContextSubmenu label="连接已有卡片">
        {() => existingCards().map(({ id, label, choose }) =>
          <button role="menuitem" className="app-context-item px-2 py-1.5" key={id}
            onClick={event => choose(event.currentTarget.getBoundingClientRect())}>{label}</button>)}
      </ContextSubmenu>}
      {note && <ContextSubmenu label={direction === "input" ? "指定接收位置" : "指定内容"}>
        {() => <>
          <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => note.selectScope()}>
            {direction === "input" ? "追加到卡片" : "全部内容"}
          </button>
          {direction === "input" && ["row", "column"].flatMap(axis =>
            (axis === "row" ? note.cells.map(row => row[0]) : note.cells[0]).map((cell, index) =>
              <button role="menuitem" className="app-context-item px-2 py-1.5" key={`${axis}:${cell.id}`}
                onClick={() => note.selectScope(`${axis}:${cell.id}`)}>第 {index + 1} {axis === "row" ? "行" : "列"}</button>))}
          {note.cells.flatMap((row, r) => row.map((cell, c) =>
            <button role="menuitem" className="app-context-item px-2 py-1.5" key={cell.id}
              onClick={() => note.selectScope(cell.id)}>第 {r + 1} 行，第 {c + 1} 列</button>))}
        </>}
      </ContextSubmenu>}
      {note && direction === "output" && <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={note.toggleLatest}>
        {note.latest ? "使用全部内容" : "仅使用最新一行"}
      </button>}
    </>}
  </ContextMenu>;
}
