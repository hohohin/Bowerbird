import { api } from "./api";
import type { Asset } from "./types";
import { placeWorkflowOutput } from "./canvasOutputPlacement";
import { emit } from "@tauri-apps/api/event";
import { renderLayerDocument } from "./layerDocument";
import { workflowLayerDecompose } from "./workflowLayerDecompose";
import { readCanvasNote, emptyCanvasCell, canvasTextMinSize } from "./canvasNotes";
import { canvasContentInput } from "./canvasContentInput";
import { workflowInputProducers, type WorkflowNode, type WorkflowStep } from "./canvasWorkflow";
import type { WorkflowExecutionHost } from "./workflowExecutionHost";

export async function executeLayers(host: WorkflowExecutionHost, runId: string, node: WorkflowNode,
  step: WorkflowStep, halted: () => boolean, assetIds: string[], orderedAssets: Asset[]) {
  const id = node.id;
  await host.withResource(`layer:${assetIds[0]}`, async () => {
    if (halted()) return;
    const key = step.layerRequestKey ?? `layers-${crypto.randomUUID()}`;
    const create = step.status === "pending" && !step.layerRequestKey;
    if (!create && !step.layerRequestKey) throw new Error("原分层步骤没有拆分任务，请重新运行卡片");
    await host.step(runId, id, { status: "running", assetId: assetIds[0], layerRequestKey: key });
    const document = await workflowLayerDecompose(assetIds[0], orderedAssets[0].store_path!, "", key, create, halted,
      detail => host.progress(runId, id, detail));
    if (halted()) return;
    const productIds: string[] = [];
    for (const [index, layer] of document.layers.entries()) {
      if (host.isStopped(runId)) return;
      host.progress(runId, id, `导出第 ${index + 1}/${document.layers.length} 层：${layer.name}`);
      const doc = { ...document, layers: document.layers.map(item => ({ ...item, visible: item.id === layer.id })) };
      const image = await api.layerExport(assetIds[0], doc, await renderLayerDocument(doc), host.projectId, true);
      productIds.push(image.id);
    }
    if (host.isStopped(runId)) return;
    const products = [...new Set(productIds)];
    await host.withResource("canvas", async () => {
      if (halted()) return;
      const canvas = await api.projectCanvasGet(host.projectId);
      const writers = host.document.nodes.filter(candidate => candidate.textTarget?.image && candidate.inputs.image?.some(input => input.nodeId === id && input.portId === "image"));
      let resultId: string | undefined;
      if (!writers.length) {
        const previousTable = canvas.nodes.find(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
        resultId = previousTable?.id ?? `workflow-layers:${runId}:${id}`;
        const previous = previousTable && readCanvasNote(previousTable);
        const cells = previous?.cells ?? [[{ ...emptyCanvasCell(), id: crypto.randomUUID() }]];
        const slots = cells.flat().filter(cell => cell.content_type === "image").map(cell => cell.id!);
        const payload = canvasContentInput({ ...previous, schema_version: 1, note_type: "text", title: previous?.title ?? "拆分产物", cells, text: "", member_ids: [] },
          { nodeId: resultId, cellId: cells[0][0].id!, append: true, ...(slots.length > 1 ? { cellIds: slots } : {}) }, { type: "image", assetIds: products }).note;
        const minimum = canvasTextMinSize(payload.cells);
        if (host.isStopped(runId)) return;
        if (previousTable) {
          await api.projectCanvasNoteUpdate(resultId, JSON.stringify(payload));
          if (previousTable.width < minimum.width || previousTable.height < minimum.height) await api.projectCanvasNodeUpdate(resultId, {
            x: previousTable.x, y: previousTable.y, width: Math.max(previousTable.width, minimum.width), height: Math.max(previousTable.height, minimum.height), zIndex: previousTable.zIndex, positionLocked: previousTable.positionLocked,
          });
        }
        else {
          const width = Math.max(440, minimum.width), height = Math.max(260, minimum.height);
          const { x, y } = placeWorkflowOutput(canvas, host.layoutNodes(), node, { width, height });
          await api.projectCanvasNodeCreate({ id: resultId, projectId: host.projectId, threadId: host.run(runId).threadId, kind: "note", assetId: null, role: null,
            payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
        }
      }
      if (host.isStopped(runId)) return;
      await host.save({ ...host.document, nodes: host.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: resultId ? [resultId] : [], resultGroupId: undefined } : item) });
      const reveal = !host.document.nodes.some(item => Object.values(item.inputs).flat().some(input => workflowInputProducers(host.document.nodes, input).includes(id)));
      await emit("creative://changed", { projectId: host.projectId, threadId: host.run(runId).threadId, jobId: runId, turnKey: resultId ?? id, status: "done", ...(reveal && resultId ? { revealProductNodeId: resultId } : {}) });
    });
    if (halted()) return;
    await host.finish(runId, node, { image: { type: "image", assetIds: products } }, []);
  });
}
