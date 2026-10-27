import { workflowInputProducers, workflowInputValues, WorkflowNodeError, type WorkflowNode, type WorkflowLoop, type WorkflowLoopItem, type WorkflowValue } from "./canvasWorkflow";
import { canvasTableValue, emptyCanvasCell, readCanvasNote } from "./canvasNotes";
import { contentTableRows } from "./contentTable";
import { canvasInputValue, canvasSessionImages } from "./canvasSessionOutputs";
import type { CanvasNode } from "./types";

/** The loop owns every effective descendant, including native content writers. */
export function workflowLoopScope(nodes: WorkflowNode[], order: string[]): WorkflowLoop | undefined {
  const loops = nodes.filter(node => node.kind === "loop" && order.includes(node.id));
  if (!loops.length) return;
  if (loops.length > 1) throw new WorkflowNodeError("一次流程暂只支持一张循环卡片，请分别启动独立循环", loops[1]);
  const owner = loops[0], body = new Set([owner.id]);
  for (const id of body) for (const node of nodes) {
    if (Object.values(node.inputs).flat().some(input => workflowInputProducers(nodes, input).includes(id))) body.add(node.id);
  }
  body.delete(owner.id);
  if (!body.size) throw new WorkflowNodeError("请把循环的当前项连接到需要逐项执行的下游卡片", owner);
  if ([...body].some(id => !order.includes(id))) throw new WorkflowNodeError("请从循环卡片或它的上游触发器启动完整循环", owner);
  const startItem = owner.loopStartItem ?? 1;
  if (!Number.isInteger(startItem) || startItem < 1 || startItem > 100) throw new WorkflowNodeError("循环起始项须为 1–100 的整数", owner);
  return { nodeId: owner.id, bodyIds: order.filter(id => body.has(id)), startIndex: startItem - 1, index: startItem - 1, completed: [] };
}

export function validateLoopItems(items: WorkflowLoopItem[], node: WorkflowNode) {
  if (!items.length) throw new WorkflowNodeError("循环输入为空，请先添加待处理内容", node);
  if (items.length > 100) throw new WorkflowNodeError("一次循环最多处理 100 项，请减少输入", node);
  return items;
}

export function validateLoopStart(items: WorkflowLoopItem[], index: number, node: WorkflowNode) {
  if (index >= items.length) throw new WorkflowNodeError(`循环只有 ${items.length} 项，不能从第 ${index + 1} 项开始`, node);
  return items;
}

/** The selector and executor must use the same input order and empty-row rules. */
export function workflowLoopItems(node: WorkflowNode, nodes: WorkflowNode[], canvas: CanvasNode[], readCell?: (nodeId: string, cellId: string) => string | WorkflowValue | undefined): WorkflowLoopItem[] {
  if (node.loopMode === "count") {
    if (!Number.isInteger(node.loopCount) || node.loopCount! < 1 || node.loopCount! > 100) throw new WorkflowNodeError("循环次数须为 1–100 的整数", node);
    return Array.from({ length: node.loopCount! }, (_, index) => ({ text: `第 ${index + 1} 轮`, assetIds: [] }));
  }
  if (node.loopMode === "rows") return workflowLoopRows(node, nodes, canvas);
  const values = workflowInputValues(nodes, node, readCell ?? ((id, cellId) => {
    const source = canvas.find(card => card.id === id && card.hiddenAt == null);
    return source ? canvasInputValue(source, cellId, canvas) : undefined;
  }));
  const images = values.image.flatMap(value => [...(value.assetIds ?? []), ...(value.nodeIds ?? []).flatMap(id => {
    const session = canvas.find(item => item.id === id && item.kind === "prompt" && item.hiddenAt == null);
    if (!session || JSON.parse(session.payloadJson).status !== "done") throw new WorkflowNodeError("上游图片尚未生成完成，请等待原生成任务", node);
    const outputs = canvasSessionImages(session, canvas).filter(item => item.hiddenAt == null);
    return outputs.slice(-1).map(item => item.assetId!);
  })]);
  return validateLoopItems(images.map(assetId => ({ text: "", assetIds: [assetId] })), node);
}

/** Native rows retain text/image pairing; never zip independently flattened columns. */
export function workflowLoopRows(node: WorkflowNode, nodes: WorkflowNode[], canvas: CanvasNode[]): WorkflowLoopItem[] {
  const inputs = node.inputs.text ?? [];
  if (inputs.length !== 1) throw new WorkflowNodeError("逐行循环需要连接一张完整内容卡或一个表格输出", node);
  const input = inputs[0];
  let items: WorkflowLoopItem[];
  if (input.canvasNodeId) {
    const source = canvas.find(card => card.id === input.canvasNodeId && card.kind === "note" && card.hiddenAt == null);
    if (!source || input.cellId !== "*text") throw new WorkflowNodeError("请连接内容卡的整体文本输出，逐行循环不接单个单元格", node);
    const note = readCanvasNote(source);
    items = note.cells.map(row => {
      const { text, table, assetIds } = canvasTableValue([row]);
      return { text, table, assetIds };
    }).filter(item => item.text || item.assetIds.length);
  } else {
    const value = nodes.find(source => source.id === input.nodeId)?.outputs[input.portId ?? "text"];
    const table = value?.table;
    if (!table) throw new WorkflowNodeError("逐行循环需要真实表格输出，请先让上游输出表格或连接内容卡", node);
    items = contentTableRows(table).map((row, r) => {
      const { text, table: rowTable, assetIds } = canvasTableValue([row.map((text, c) => ({ ...emptyCanvasCell(), text,
        content_type: table.imageCells?.some(([y, x]) => y === r && x === c) ? "image" : "text",
        image_refs: value?.imageRefs?.filter(ref => text.split(ref.token).slice(1).some(suffix => !/^\d/.test(suffix))) } ))]);
      return { text, table: rowTable, assetIds };
    }).filter(item => item.text || item.assetIds.length);
  }
  return validateLoopItems(items, node);
}

export function workflowLoopOutputs(item: WorkflowLoopItem, index: number): Record<string, WorkflowValue> {
  return { text: { type: "text", text: item.text, ...(item.table ? { table: item.table } : {}), assetIds: item.assetIds, imageRefs: item.assetIds.map((asset_id, i) => ({ asset_id, token: `@图片${i + 1}` })) },
    image: { type: "image", assetIds: item.assetIds }, iteration: { type: "text", text: String(index + 1) } };
}
