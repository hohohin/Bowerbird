import { describeAssetWithNotice } from "./describeNotices";
import { api } from "./api";
import type { Asset } from "./types";
import { placeWorkflowOutput } from "./canvasOutputPlacement";
import { emit } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { existingWorkflowCaption, workflowCaptionSections, workflowDescribeInstruction } from "./workflowDescribe";
import { understandProvider } from "./entitlement";
import { readCanvasNote } from "./canvasNotes";
import { type WorkflowNode, type WorkflowStep } from "./canvasWorkflow";
import type { WorkflowExecutionHost } from "./workflowExecutionHost";

export async function executeReuse(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, assetIds: string[]) {
  const history = await api.generationHistory(assetIds[0], null);
  // Use the compiled prompt so dimension chips cannot leak unresolved tokens downstream.
  const text = history.turns[0]?.prompt;
  if (!text) throw new Error("这张图片没有可复用的生成提示词");
  await host.finish(runId, node, { text: { type: "text", text }, image: { type: "image", assetIds: history.references.map(asset => asset.id) } });
}

export async function executeDescribe(host: WorkflowExecutionHost, runId: string, node: WorkflowNode,
  step: WorkflowStep, halted: () => boolean, assetIds: string[], orderedAssets: Asset[]) {
  const id = node.id;
  if (step.status !== "pending") throw new Error("上次反推的结果未知。请检查该图反推记录，停止流程后显式重试。");
  const state = useStore.getState();
  const instruction = workflowDescribeInstruction(node);
  const cached = assetIds.map(assetId => node.overwriteDescribe ? [] : existingWorkflowCaption(node, assetId, instruction));
  if (host.isStopped(runId)) return;
  const provider = state.defaultUnderstandProvider === "auto" ? understandProvider(state.cloudEntitlement) : state.defaultUnderstandProvider;
  if (!provider && cached.some(parts => !parts.length)) throw new Error("当前没有可用的反推引擎");
  const sections: Array<{ title: string; body: string }> = [];
  const rows: Array<{ assetId: string; name: string; prompt: string }> = [];
  const jobs = assetIds.map((_, index) => cached[index].length ? null : `workflow-describe-${crypto.randomUUID()}`);
  const describeJobIds = jobs.filter((job): job is string => !!job);
  const reused = cached.filter(parts => parts.length).length;
  await host.step(runId, id, { status: "running", describeJobIds, detail: `复用 ${reused} 张 · 反推 ${describeJobIds.length} 张` });
  let completed = 0, failed = false;
  let firstError: unknown;
  const pending = new Set(describeJobIds);
  // Settle all started requests before unlocking the card; an error cancels only this batch.
  const results = await Promise.allSettled(assetIds.map(async (assetId, index) => {
    try {
      if (cached[index].length) return cached[index];
      const analysisId = await describeAssetWithNotice(assetId, orderedAssets[index].name, instruction, provider!, jobs[index]!);
      const analysis = (await api.listAnalysesByAsset(assetId)).find(item => item.id === analysisId);
      const parts = analysis ? workflowCaptionSections(analysis.payload) : [];
      if (!parts?.length) throw new Error(`第 ${index + 1} 张图片反推未返回可用维度`);
      completed++;
      if (!failed) host.progress(runId, id, `复用 ${reused} 张 · 并行反推 ${describeJobIds.length} 张 · 已完成 ${completed}/${describeJobIds.length}`);
      return parts;
    } catch (error) {
      if (!failed) {
        failed = true; firstError = error;
        host.progress(runId, id, `反推失败，正在停止本批次剩余任务`);
        await Promise.allSettled([...pending].filter(jobId => jobId !== jobs[index]).map(jobId => api.cancelCodexDescribe(jobId)));
      }
      throw error;
    } finally { if (jobs[index]) pending.delete(jobs[index]!); }
  }));
  if (host.isStopped(runId)) return;
  if (failed) throw firstError;
  // Keep this card's successful batch independently of image history and transient outputs.
  const describeCache = { instruction, results: assetIds.map((assetId, index) => {
    const result = results[index];
    if (result.status !== "fulfilled") throw result.reason;
    return { assetId, sections: result.value };
  }) };
  await host.save({ ...host.document, nodes: host.document.nodes.map(candidate => candidate.id === id ? { ...candidate, describeCache } : candidate) });
  if (halted()) return;
  for (const [index, assetId] of assetIds.entries()) {
    const result = results[index];
    if (result.status !== "fulfilled") throw result.reason;
    const parts = result.value;
    rows.push({ assetId, name: orderedAssets[index].name, prompt: parts.map(part => `${part.title}：${part.body}`).join("\n\n") });
    for (const part of parts) {
      const body = assetIds.length > 1 ? `图片 ${index + 1}：${part.body}` : part.body;
      const existing = sections.find(section => section.title === part.title);
      if (existing) existing.body += `\n\n${body}`; else sections.push({ title: part.title, body });
    }
  }
  const promptText = sections.map(section => `${section.title}：${section.body}`).join("\n\n");
  await host.withResource("canvas", async () => {
    if (halted()) return;
    host.progress(runId, id, `已反推 ${rows.length} 张图片，正在生成素材 / 提示词表格`);
    const tableId = `workflow-describe:${runId}:${id}`;
    const cell = (text: string, key: string, bold = false) => ({ id: key, text, bold, italic: false, align: "left" });
    const cells = [[cell("素材", "heading-asset", true), cell("提示词", "heading-prompt", true)],
      ...rows.map(row => [{ ...cell("@图片1", `${row.assetId}-asset`), content_type: "image", image_refs: [{ asset_id: row.assetId, token: "@图片1" }] }, cell(row.prompt, `${row.assetId}-prompt`)])];
    const canvas = await api.projectCanvasGet(host.projectId);
    const writers = host.document.nodes.filter(candidate => candidate.textTarget && candidate.inputs.text?.some(input => input.nodeId === id && input.portId === "text"));
    const width = 640, height = 40 + 100 * cells.length;
    const { x, y } = placeWorkflowOutput(canvas, host.layoutNodes(), node, { width, height }, new Set([tableId]));
    const previousTables = canvas.nodes.filter(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
    const payload = { schema_version: 1, note_type: "text", title: `反推结果 · ${rows.length} 张素材`, cells, text: cells.map(row => row.map(item => item.text).join("\t")).join("\n"), member_ids: [], column_widths: [1, 3], row_heights: [0.45, ...rows.map(() => 1)] };
    if (previousTables.length) {
      for (const table of previousTables) {
        const previous = readCanvasNote(table);
        const updatedCells = cells.map((row, r) => row.map((cell, c) => ({ ...cell, id: previous.cells[r]?.[c]?.id ?? cell.id })));
        await api.projectCanvasNoteUpdate(table.id, JSON.stringify({ ...payload, cells: updatedCells }));
      }
    } else if (!writers.length) {
      await api.projectCanvasNodeCreate({ id: tableId, projectId: host.projectId, threadId: host.run(runId).threadId, kind: "note", assetId: null, role: null,
        payloadJson: JSON.stringify(payload), x, y, width, height, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
      await host.save({ ...host.document, nodes: host.document.nodes.map(item => item.id === id ? { ...item, resultNodeIds: [tableId] } : item) });
    }
    await emit("creative://changed", { projectId: host.projectId, threadId: host.run(runId).threadId, jobId: runId, turnKey: tableId, status: "done" });
  });
  if (halted()) return;
  await host.finish(runId, node, { text: { type: "text", text: promptText } }, []);
}
