import { workflowInputProducers, WorkflowNodeError, type WorkflowNode, type WorkflowLoop, type WorkflowLoopItem, type WorkflowValue } from "./canvasWorkflow";
import { canvasCellValue, readCanvasNote } from "./canvasNotes";
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
  return { nodeId: owner.id, bodyIds: order.filter(id => body.has(id)), index: 0, completed: [] };
}

export function validateLoopItems(items: WorkflowLoopItem[], node: WorkflowNode) {
  if (!items.length) throw new WorkflowNodeError("循环输入为空，请先添加待处理内容", node);
  if (items.length > 100) throw new WorkflowNodeError("一次循环最多处理 100 项，请减少输入", node);
  return items;
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
      const values = row.map(canvasCellValue);
      const assetIds = [...new Set(values.flatMap(value => value.assetIds))];
      const text = row.map((cell, index) => cell.content_type === "image" ? "" : cell.text.replace(/@图片\d+/g, token => {
        const ref = values[index].imageRefs.find(ref => ref.token === token);
        return ref ? `@图片${assetIds.indexOf(ref.asset_id) + 1}` : token;
      })).join("\t").trim();
      return { text, assetIds };
    }).filter(item => item.text || item.assetIds.length);
  } else {
    const table = nodes.find(source => source.id === input.nodeId)?.outputs[input.portId ?? "text"]?.table;
    if (!table) throw new WorkflowNodeError("逐行循环需要真实表格输出，请先让上游输出表格或连接内容卡", node);
    items = table.rows.map(row => ({ text: row.map((value, index) => `${table.columns[index]}：${value}`).join("\n"), assetIds: [] }));
  }
  return validateLoopItems(items, node);
}

export function workflowLoopOutputs(item: WorkflowLoopItem): Record<string, WorkflowValue> {
  return { text: { type: "text", text: item.text, assetIds: item.assetIds, imageRefs: item.assetIds.map((asset_id, i) => ({ asset_id, token: `@图片${i + 1}` })) },
    image: { type: "image", assetIds: item.assetIds } };
}
