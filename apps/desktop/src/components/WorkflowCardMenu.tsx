import { userErrorMessage } from "../lib/userError";
import { ContextMenu, ContextSubmenu } from "./ContextMenu";
import { readCanvasNote } from "../lib/canvasNotes";
import { WORKFLOW_CARD_PRESENTATION, WorkflowLayerProps, VIDEO_REFERENCE_OPTIONS, CONNECTION_CARDS } from "./workflowLayerShared";
import type { WorkflowLayerState } from "./useWorkflowLayerState";
import type { WorkflowConnections } from "./useWorkflowConnections";

export function WorkflowCardMenu({ props, layer, connections }: { props: WorkflowLayerProps; layer: WorkflowLayerState; connections: WorkflowConnections }) {
  const {
    graphNodes, materials, conversationCards
  } = props;
  const {
    cardMenu, videoConnection, connectionMenu, setBlankCardMenu, blankCardMenu, controller,
    generationAnchorOwners, nodeById, cardNames, graphById
  } = layer;
  const {
    clearAutomatic, videoReferenceError, commitAutomatic, newConnectionError, connectionCard,
    createConnected, addCard, receiverError, gestureOutputs, automaticTarget,
    chooseAutomaticReceiver, selectConnectionScope, beginAutomatic
  } = connections;
  return <>
    {cardMenu && <ContextMenu key={videoConnection ? "video-reference" : connectionMenu ? connectionMenu.gesture.scope ?? "all" : "blank"} x={cardMenu.x} y={cardMenu.y}
      label={videoConnection ? "引用视频" : connectionMenu ? connectionMenu.gesture.side === "output" ? "添加下游" : "添加上游" : "新建卡片"}
      trigger={videoConnection ? connectionMenu?.gesture.trigger : undefined}
      onClose={connectionMenu ? clearAutomatic : () => setBlankCardMenu(null)}>
      {videoConnection ? VIDEO_REFERENCE_OPTIONS.map(({ label, frame }) => {
        const { output, target, created } = videoConnection;
        const error = videoReferenceError(videoConnection, frame);
        return <button key={label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={!!error} title={error ?? undefined}
          onClick={() => commitAutomatic([output], target, created ? [created] : [], frame)}>{label}</button>;
      }) : <>
      {CONNECTION_CARDS.map(option => {
        const error = connectionMenu && newConnectionError(connectionMenu.gesture, connectionCard(option, { x: 0, y: 0 }));
        const Icon = WORKFLOW_CARD_PRESENTATION[option.kind].icon;
        return <button key={option.label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={!!error} title={error ? userErrorMessage(error, "此卡片暂时不能连接") : undefined} onClick={() => {
          if (connectionMenu) createConnected(option);
          else if (blankCardMenu) {
            setBlankCardMenu(null);
            addCard(connectionCard(option, blankCardMenu.point));
          }
        }}><Icon size={15} />{option.label}</button>;
      })}
      {connectionMenu && <>
      <ContextSubmenu label="连接已有卡片">
        {() => [...new Set([...controller.document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => node.id),
          ...graphNodes.filter(node => node.hiddenAt == null).map(node => node.id), ...materials.map(item => item.id)])].filter(id => {
          if (id === connectionMenu.gesture.id) return false;
          if (connectionMenu.gesture.side === "output" && generationAnchorOwners.has(id)) return false;
          if (connectionMenu.gesture.side === "input" && nodeById.get(connectionMenu.gesture.id)?.kind === "trigger" && conversationCards?.hiddenIds.has(id)) return false;
          return !receiverError(gestureOutputs(connectionMenu.gesture, id), connectionMenu.gesture.side === "output" ? automaticTarget(id) : connectionMenu.gesture.target);
        }).map(id => <button role="menuitem" className="app-context-item px-2 py-1.5" key={id} onClick={event => {
          const { gesture, x, y } = connectionMenu;
          const rect = event.currentTarget.getBoundingClientRect();
          chooseAutomaticReceiver(gesture, gestureOutputs(gesture, id), gesture.side === "output" ? automaticTarget(id) : gesture.target,
            { x: rect.right < innerWidth - 150 ? rect.right + 4 : x, y: rect.top || y });
        }}>{cardNames[id] ?? "卡片"}</button>)}
      </ContextSubmenu>
      {(() => {
        const card = graphById.get(connectionMenu.gesture.id);
        if (card?.kind !== "note") return null;
        const note = readCanvasNote(card), input = connectionMenu.gesture.side === "input";
        if (!["text", "images"].includes(note.note_type)) return null;
        return <ContextSubmenu label={input ? "指定接收位置" : "指定内容"}>
          {() => <>
            <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => selectConnectionScope()}>{input ? "追加到卡片" : "全部内容"}</button>
            {input && ["row", "column"].flatMap(axis => (axis === "row" ? note.cells.map(row => row[0]) : note.cells[0]).map((cell, index) =>
              <button role="menuitem" className="app-context-item px-2 py-1.5" key={`${axis}:${cell.id}`} onClick={() => selectConnectionScope(`${axis}:${cell.id}`)}>第 {index + 1} {axis === "row" ? "行" : "列"}</button>))}
            {note.cells.flatMap((row, r) => row.map((cell, c) => <button role="menuitem" className="app-context-item px-2 py-1.5" key={cell.id} onClick={() => selectConnectionScope(cell.id)}>第 {r + 1} 行，第 {c + 1} 列</button>))}
          </>}
        </ContextSubmenu>;
      })()}
      {connectionMenu.gesture.side === "output" && (() => { const card = graphById.get(connectionMenu.gesture.id); return card?.kind === "note" && ["text", "images"].includes(readCanvasNote(card).note_type); })() &&
        <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => beginAutomatic(connectionMenu.gesture.id, "output", { x: connectionMenu.x, y: connectionMenu.y }, true, !connectionMenu.gesture.latest)}>{connectionMenu.gesture.latest ? "使用全部内容" : "仅使用最新一行"}</button>}
      </>}
      </>}
    </ContextMenu>}
  </>;
}
