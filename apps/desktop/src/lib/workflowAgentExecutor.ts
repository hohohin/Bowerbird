import { resolveNewCardImageProvider } from "./newCardImageProvider";
import { cloudChatEndedMessage } from "./userError";
import { workflowCardWidth } from "./canvasWorkflow";
import { api } from "./api";
import type { Asset } from "./types";
import { placeWorkflowOutput } from "./canvasOutputPlacement";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath } from "./videoGeneration";
import { selectedChatOptions, chatProviderAccessIssue } from "./chatCapabilities";
import { generationProviderIssue } from "./generationAvailability";
import { autoRatioFromReferences } from "../components/creation/ratios";
import { emit } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { readCanvasNote, emptyCanvasCell, canvasGridWeights, canvasTextMinSize } from "./canvasNotes";
import { agentResultValue } from "./workflowAgentResult";
import { agentChatOptions, localChat, localChatRunning, type ChatConversation } from "./localChat";
import { ensureLocalChatEvents, useLocalChatStore } from "./localChatStore";
import { terminalDshTurnFailure, workflowAgentMessage, workflowAgentProvider, workflowChatOutputs } from "./workflowAgentChat";
import { contentTableRows } from "./contentTable";
import { cloudAgentProfilePrompt } from "./workflowAgentProfile";
import { agentTextWriters, routeAgentOutputs } from "./workflowAgentOutputs";
import { ConfirmedDshTurnFailure, WorkflowNodeError } from "./workflowDiagnostics";
import { type WorkflowNode, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";
import type { WorkflowExecutionHost } from "./workflowExecutionHost";

export async function waitForChatTurn(host: WorkflowExecutionHost, initial: ChatConversation, turnId: string, halted: () => boolean): Promise<ChatConversation | null> {
  await ensureLocalChatEvents();
  // Reconcile once after five quiet seconds. This covers a lost final event.
  // While revisions are arriving, no database polling is needed.
  let latest = initial;
  let timer: ReturnType<typeof setTimeout>;
  let finished = false, checking = false;
  let unsubscribeChat = () => {}, unsubscribeRun = () => {};
  try {
    return await new Promise<ChatConversation | null>((resolve, reject) => {
      function observe() {
        if (finished) return;
        if (halted()) { finished = true; resolve(null); return; }
        const cached = useLocalChatStore.getState().conversations[initial.id];
        if (cached && cached.revision > latest.revision) latest = cached;
        if (!localChatRunning(latest) || latest.messages[latest.messages.length - 1]?.turnId !== turnId) {
          finished = true; resolve(latest);
        }
      }
      function schedule() { clearTimeout(timer); timer = setTimeout(reconcile, 5000); }
      async function reconcile() {
        if (finished) return;
        checking = true;
        try {
          const revision = await localChat.revision(initial.id);
          if (finished) return;
          if (revision == null) throw new Error("原对话已不存在");
          if (revision > latest.revision) {
            const snapshot = await useLocalChatStore.getState().loadConversation(initial.id);
            if (!snapshot) throw new Error("原对话已不存在");
            if (snapshot.revision > latest.revision) latest = snapshot;
          }
          observe();
          if (!finished) schedule();
        } catch (error) { finished = true; reject(error); }
        finally { checking = false; }
      }
      unsubscribeChat = useLocalChatStore.subscribe((state, previous) => {
        if (state.conversations[initial.id] === previous.conversations[initial.id]) return;
        observe();
        if (!finished && !checking) schedule();
      });
      unsubscribeRun = host.subscribe(observe);
      observe();
      if (!finished) schedule();
    });
  } finally {
    finished = true; clearTimeout(timer!);
    unsubscribeChat(); unsubscribeRun();
  }
}

export async function chatResult(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, step: WorkflowStep, assets: Asset[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null> {
  const store = useLocalChatStore.getState();
  let input = step.chatInput;
  if (!input) {
    if (step.status !== "pending") throw new Error("原 Agent 提交状态未知，请先核对原任务，不能重新提交");
    await store.loadProject(host.projectId);
    const summaries = useLocalChatStore.getState().summaries;
    const existing = node.chatConversationId ? summaries[node.chatConversationId]
      : Object.values(summaries).find(chat => chat.projectId === host.projectId && chat.nodeId === node.id);
    const provider = existing?.provider ?? workflowAgentProvider(node);
    const issue = chatProviderAccessIssue(provider, useStore.getState());
    if (issue) throw new WorkflowNodeError(issue.message, node);
    const run = host.run(runId), snapshot = run.steps[node.id].agentInput!;
    input = { requestId: crypto.randomUUID(), projectId: host.projectId, agentNodeId: node.id,
      ...(run.manualCardRun && run.startId === node.id ? { manualCardRun: true } : {}),
      conversationId: existing?.id ?? node.chatConversationId, provider,
      codexOptions: selectedChatOptions(provider, agentChatOptions(provider, existing ? useLocalChatStore.getState().drafts[existing.id]?.codexOptions ?? existing.codexOptions ?? node.chatCodexOptions : node.chatCodexOptions)),
      text: workflowAgentMessage(cloudAgentProfilePrompt(snapshot.prompt, snapshot.visualProfile), snapshot.source, provider, assets.map(asset => isVideoPath(asset.store_path!) ? "视频" : "图片")),
      referenceAssetIds: snapshot.assetIds,
      cardDefaults: { provider: resolveNewCardImageProvider(useStore.getState()), videoChannel: "jimeng", videoOptions: { ...DEFAULT_VIDEO_OPTIONS } },
      placement: { x: node.x, y: node.y, width: workflowCardWidth(node), height: node.layoutSize?.height ?? 330, zIndex: Date.now() % 1000000 } };
    await host.step(runId, node.id, { status: "running", chatInput: input, detail: "正在发送" });
  }
  let chat: ChatConversation | null;
  try {
    chat = await localChat.getByRequest(input.requestId);
    if (halted()) return null;
    // Only a recorded turn identifies a prior submission. Older retry snapshots also
    // stored the conversation ID before their new request was ever sent.
    if (!chat && step.chatTurnId) throw new Error("原 Agent 轮次记录已不存在，无法取回");
    if (!chat) chat = await store.send(input); // The persisted native request key makes an uncertain IPC replay safe.
  } catch (error) {
    if (!halted()) await host.step(runId, node.id, { status: "waiting", error: String(error), detail: "等待核对原回复" });
    return null;
  }
  if (chat.projectId !== host.projectId || chat.nodeId !== node.id || !chat.submittedTurnId || (input.conversationId && chat.id !== input.conversationId)
    || (step.chatTurnId && step.chatTurnId !== chat.submittedTurnId) || (step.chatConversationId && step.chatConversationId !== chat.id)) throw new Error("Agent 回复与原卡片或轮次不匹配");
  const turnId = chat.submittedTurnId;
  if (halted()) { if (localChatRunning(chat)) await store.stop(chat.id, turnId); return null; }
  await host.refreshExternalCards();
  await host.step(runId, node.id, { status: "running", chatConversationId: chat.id, chatTurnId: turnId, detail: "正在回复" });
  if (halted()) return null;
  store.applyConversation(chat);
  if (localChatRunning(chat) && chat.messages[chat.messages.length - 1]?.turnId === turnId) {
    try { chat = await waitForChatTurn(host, chat, turnId, halted); }
    catch (error) {
      if (!halted()) await host.step(runId, node.id, { status: "waiting", error: String(error), detail: "等待取回原回复" });
      return null;
    }
    if (!chat || halted()) return null;
  }
  const messages = chat.messages.filter(message => message.turnId === turnId && message.role === "assistant");
  if (messages.some(message => ["failed", "interrupted", "stopped"].includes(message.status))) {
    if (chat.messages[chat.messages.length - 1]?.turnId === turnId && cloudChatEndedMessage(chat.error)) throw new Error(chat.error!);
    // A host-confirmed failure is terminal: waiting and re-querying the same turn would keep
    // showing "take back the original reply" for a reply that can never exist.
    const terminal = terminalDshTurnFailure(chat, turnId, step.confirmedFailedChatTurnId);
    if (terminal) throw new ConfirmedDshTurnFailure(terminal.message, node, terminal.code);
    await host.step(runId, node.id, { status: "waiting", error: (chat.messages[chat.messages.length - 1]?.turnId === turnId && chat.error) || "回复未完成，请打开对话详情取回原回复后继续" });
    return null;
  }
  return workflowChatOutputs(chat, turnId);
}

async function localDsResult(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, step: WorkflowStep, images: string[], halted: () => boolean): Promise<Record<string, WorkflowValue> | null> {
  const requestId = step.localDsRequestId!;
  const transport = step.localAgentTransport ?? "local-ds";
  const agentName = transport === "codex-cli" ? "Codex CLI" : "Agent DS";
  const videoTask = step.localAgentSkill === "hyperframes";
  while (!halted()) {
    if (!await localDsGenerate(host, runId, node, requestId, images, halted)) return null;
    if (!await host.deliverSubmittedSessions(runId, node, halted)) return null;
    const result = await api.agentDsWorkflowResult(requestId);
    if (halted()) return null;
    if (result) {
      if (result.schemaVersion !== 1 || result.requestId !== requestId) throw new Error(`${agentName} 返回了其他请求的结果`);
      if (result.error) throw new Error(`${agentName} 处理失败：${result.error}（请求 ${requestId}）`);
      const outputs: Record<string, WorkflowValue> = {};
      const sessions = Object.values(host.run(runId).steps[node.id].localDsGenerations ?? {}).flatMap(call => call.response?.submitted ? [call.response.submitted.sessionNodeId] : []);
      if (sessions.length) outputs.image = { type: "image", nodeIds: sessions };
      if (result.text !== undefined) outputs.text = agentResultValue(result.text);
      if (result.images !== undefined && (!Array.isArray(result.images) || !result.images.length || result.images.some(path => typeof path !== "string" || !path.trim()))) throw new Error(`${agentName} 返回图片格式无效`);
      const media = result.videos ?? result.images;
      if (result.videos && (!videoTask || transport !== "codex-cli" || result.videos.length !== 1)) throw new Error("视频交付与当前任务不匹配，请检查原请求");
      if (media?.length) {
        const assets = await api.agentDsWorkflowIngestImages(requestId);
        if (halted()) return null;
        if (assets.length !== media.length) throw new Error(`${agentName} 素材未完整入库，请继续取回原请求`);
        const imageIds = assets.map(asset => asset.id);
        await host.step(runId, node.id, { generatedAssetIds: [...new Set(imageIds)] });
        if (halted()) return null;
        if (result.videos) {
          await host.step(runId, node.id, { videoProjectPath: result.projectPath });
          await host.deliverMediaAsset(host.run(runId), node, assets[0], halted, `workflow-video:${requestId}`);
          if (halted()) return null;
        }
        // Directed results index the outer images array, including duplicate bytes.
        outputs.image = { ...outputs.image, type: "image", assetIds: host.run(runId).steps[node.id].agentOutputTargets?.length ? imageIds : [...new Set(imageIds)] };
      }
      if (!Object.keys(outputs).length) throw new Error(`${agentName} 未返回文字或图片`);
      return outputs;
    }
    // After a reload or failed delivery, Continue only checks the existing request.
    if (step.status === "waiting") {
      await host.step(runId, node.id, { status: "waiting", error: transport === "codex-cli" ? "Codex CLI 尚在处理，请稍后继续取回" : "Agent DS 尚未写回结果；请在 DSH 会话处理队列后继续", detail: `等待本机请求 ${requestId}` });
      return null;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return null;
}

async function localDsGenerate(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, requestId: string, inputImages: string[], halted: () => boolean): Promise<boolean> {
  const request = await api.agentDsWorkflowGenerationRequest(requestId);
  if (halted()) return false;
  if (!request) return true;
  const step = host.run(runId).steps[node.id];
  if (!step.localDsImageProvider) throw new Error("此旧 Agent 请求没有默认生图配置，请停止后重新运行卡片");
  let call = step.localDsGenerations?.[request.id];
  if (call && JSON.stringify(call.request) !== JSON.stringify(request)) throw new Error("Agent 生图请求使用相同 id 修改了参数");
  if (!call) {
    const issue = generationProviderIssue(step.localDsImageProvider, useStore.getState());
    if (issue) {
      await api.agentDsWorkflowGenerationResponse(requestId, request, { error: issue.message });
      return true;
    }
    const allowed = new Set([...inputImages, ...Object.values(step.localDsGenerations ?? {}).flatMap(call => call.response?.images ?? [])]);
    if (request.images.some(path => !allowed.has(path))) throw new Error("Agent 生图只能引用本卡片输入或本次已生成的图片");
    const ids = await Promise.all(request.images.map(path => api.localAgentFindAssetId(path)));
    if (ids.some(id => !id)) throw new Error("Agent 生图参考图片已失效");
    const assets = await api.getAssetsByIds(ids as string[]);
    const references = ids.map(id => assets.find(asset => asset.id === id));
    if (references.some(asset => !asset?.store_path)) throw new Error("Agent 生图参考图片已失效");
    if (halted()) return false;
    call = { request, jobId: crypto.randomUUID(), turnKey: crypto.randomUUID() };
    await host.step(runId, node.id, { localDsGenerations: { ...step.localDsGenerations, [request.id]: call }, detail: `Agent 正在使用默认生图引擎 ${step.localDsImageProvider}` });
    // Persist identity before submission. Recovery only queries this job, never submits again.
    const sessionNodeId = `gen-prompt:${call.jobId}:${call.turnKey}:0`;
    if (step.localDsGenerationMode === "session") {
      await host.save({ ...host.document, nodes: host.document.nodes.map(candidate => candidate.id === node.id
        ? { ...candidate, activeSessionNodeId: sessionNodeId, sessionNodeIds: [...(candidate.sessionNodeIds ?? []), sessionNodeId] } : candidate) });
    }
    try {
      if (step.localDsGenerationMode === "session") {
        const result = await useStore.getState().startGeneration(request.prompt, references as NonNullable<typeof references[number]>[], request.ratio,
          step.localDsImageProvider, request.prompt, undefined, undefined, undefined, step.agentInput?.visualProfile?.id ?? null,
          { projectId: host.projectId, threadId: host.run(runId).threadId }, true, undefined, { jobId: call.jobId, turnKey: call.turnKey });
        if (!result.accepted) throw new Error(result.error || "生成任务未提交");
        call = { ...call, response: { submitted: { jobId: call.jobId, turnKey: call.turnKey, sessionNodeId } } };
      } else {
        await api.codexCreateImage({
          jobId: call.jobId, turnKey: call.turnKey, internalAgent: true,
          prompt: request.prompt, promptRaw: request.prompt, referenceImages: request.images, visualProfileId: step.agentInput?.visualProfile?.id ?? null,
          ratio: request.ratio ?? autoRatioFromReferences(references as NonNullable<typeof references[number]>[]), provider: step.localDsImageProvider,
          projectId: host.projectId, threadId: host.run(runId).threadId,
        });
      }
    } catch (error) {
      call = { ...call, response: { error: String(error) } };
    }
  }
  if (halted()) return false;
  if (!call.response) {
    const previous = await api.agentDsWorkflowGenerationJob(call.jobId, call.turnKey);
    if (halted()) return false;
    if (previous && ["failed", "cancelled", "cancelled_local"].includes(previous.status)) call = { ...call, response: { error: previous.error || "默认引擎生图失败" } };
    else if (previous && step.localDsGenerationMode === "session") {
      call = { ...call, response: { submitted: { jobId: call.jobId, turnKey: call.turnKey, sessionNodeId: `gen-prompt:${call.jobId}:${call.turnKey}:0` } } };
    } else if (previous?.status === "done") {
      const images = previous.images;
      if (images.length) call = { ...call, response: { images } };
    }
  }
  if (!call.response) {
    await host.step(runId, node.id, { status: "waiting", error: step.localDsGenerationMode === "session" ? "无法确认原生成任务是否已提交，请检查任务中心后继续；不会重复提交" : "Agent 的原生图任务尚未完成，请稍后继续取回；不会重复提交" });
    return false;
  }
  await host.step(runId, node.id, { localDsGenerations: { ...host.run(runId).steps[node.id].localDsGenerations, [request.id]: call } });
  if (halted()) return false;
  if (!await host.deliverSubmittedSessions(runId, node, halted)) return false;
  try {
    await api.agentDsWorkflowGenerationResponse(requestId, request, call.response);
  } catch (error) {
    if (halted()) return false;
    await host.step(runId, node.id, { status: "waiting", error: `生图结果回传未完成，请继续重试回传：${String(error)}` });
    return false;
  }
  if (!halted()) await host.step(runId, node.id, { detail: call.response.error ? "生图失败，Agent 正在处理反馈" : call.response.submitted ? "生成任务已提交，会话卡片正在生图" : "生图完成，Agent 正在检查和整理结果" });
  return !halted();
}

async function writeAgentResult(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, value: WorkflowValue, hasWriters: boolean, halted: () => boolean) {
  if (!node.resultNodeIds?.length && (hasWriters || !value.table)) return;
  await host.withResource("canvas", async () => {
    if (halted()) return;
    const canvas = await api.projectCanvasGet(host.projectId);
    const table = canvas.nodes.find(item => node.resultNodeIds?.includes(item.id) && item.kind === "note" && item.hiddenAt == null);
    if (!table && (hasWriters || !value.table)) return;
    const id = table?.id ?? `workflow-agent:${runId}:${node.id}`;
    // Persist a stable destination before creating it; recovery can find the same node.
    if (!table) await host.save({ ...host.document, nodes: host.document.nodes.map(item => item.id === node.id ? { ...item, resultNodeIds: [id] } : item) });
    if (halted()) return;
    const previous = table ? readCanvasNote(table) : null;
    const data = value.table ? contentTableRows(value.table) : [[value.text ?? ""]];
    const width = Math.max(data[0].length, previous?.cells[0]?.length ?? 0);
    const height = Math.max(data.length, previous?.cells.length ?? 0);
    const cells = Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => ({
      ...emptyCanvasCell(), ...previous?.cells[r]?.[c], id: previous?.cells[r]?.[c]?.id ?? crypto.randomUUID(),
      content_type: "text" as const, text: data[r]?.[c] ?? "", image_refs: [], bold: !!value.table?.columns && r === 0,
    })));
    const payload = { ...previous, schema_version: 1, note_type: "text", member_ids: [], title: value.table?.title || "Agent 结果",
      cells, text: cells.map(row => row.map(cell => cell.text).join("\t")).join("\n"),
      column_widths: canvasGridWeights(previous?.column_widths, width), row_heights: canvasGridWeights(previous?.row_heights, height) };
    const minimum = canvasTextMinSize(cells);
    if (table) {
      await api.projectCanvasNoteUpdate(table.id, JSON.stringify(payload));
      if (table.width < minimum.width || table.height < minimum.height) await api.projectCanvasNodeUpdate(table.id, {
        x: table.x, y: table.y, width: Math.max(table.width, minimum.width), height: Math.max(table.height, minimum.height), zIndex: table.zIndex, positionLocked: table.positionLocked,
      });
    } else {
      const { x, y } = placeWorkflowOutput(canvas, host.layoutNodes(), node, minimum);
      await api.projectCanvasNodeCreate({ id, projectId: host.projectId, threadId: host.run(runId).threadId, kind: "note", assetId: null, role: null,
        payloadJson: JSON.stringify(payload), x, y, ...minimum, zIndex: Math.max(0, ...canvas.nodes.map(item => item.zIndex)) + 1, positionLocked: true });
    }
    await emit("creative://changed", { projectId: host.projectId });
  });
}

/** Deliver an Agent's text into the content cards it is wired to; the writer's own run then
 * rewrites the same slots, so this only moves the landing earlier (idempotent either way). */
async function writeAgentText(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, value: WorkflowValue, writers: WorkflowNode[], halted: () => boolean) {
  if (!value.table && !value.text?.trim()) return;
  for (const writer of writers) {
    if (halted()) return;
    await host.writeContentInput(runId, writer, value, halted);
  }
  if (!halted() && writers.length > 1) host.progress(runId, node.id, `已写入 ${writers.length} 张连接的内容卡`);
}

export async function executeAgent(host: WorkflowExecutionHost, runId: string, node: WorkflowNode,
  step: WorkflowStep, halted: () => boolean, { agentInput, agentVisualProfile, outputTargets, orderedAssets }: {
    agentInput: WorkflowStep["agentInput"] | null;
    agentVisualProfile: NonNullable<WorkflowStep["agentInput"]>["visualProfile"];
    outputTargets: NonNullable<WorkflowStep["agentOutputTargets"]>;
    orderedAssets: Asset[];
  }) {
  const id = node.id;
  const snapshot = step.agentInput ?? { ...agentInput!, visualProfile: agentVisualProfile };
  if (!step.agentInput) await host.step(runId, id, { agentInput: snapshot });
  if (!snapshot.prompt.trim()) throw new WorkflowNodeError("Agent 要求不能为空", node);
  if (outputTargets.length && !step.agentOutputTargets) await host.step(runId, id, { agentOutputTargets: outputTargets });
  let outputs: Record<string, WorkflowValue>;
  if (!step.localDsRequestId && !step.agentRunId) {
    const result = await chatResult(host, runId, node, step, orderedAssets, halted);
    if (!result) return;
    outputs = result;
  } else if (step.localDsRequestId) {
    const result = await localDsResult(host, runId, node, step, orderedAssets.map(asset => asset.store_path!), halted);
    if (!result) return;
    outputs = result;
  } else {
  const agentRunId = step.agentRunId!; // Legacy accepted Cloud runs are read only; new turns use localChat.
  let result;
  while (!host.isStopped(runId)) {
    const current = await api.cloudAgentGet(agentRunId);
    useStore.getState().openCloudAgentRun(current, { navigate: false });
    if (["failed", "cancelled"].includes(current.status)) {
      const code = current.snapshot.run.error_code;
      const message = code === "unified_agent_text_result_invalid" ? "模型没有返回有效的完整改写文本" : code === "unified_agent_input_invalid" ? "云端未识别文本改写输入，请检查 Worker 版本" : current.snapshot.run.safe_message || "文本改写未完成";
      throw new Error(`${message}（Cloud DSH 任务 ${agentRunId}${code ? `，${code}` : ""}）`);
    }
    if (current.status === "succeeded") { result = current; break; }
    if (current.status.startsWith("awaiting_")) throw new Error("云端未按文本改写模式执行，请检查 Cloud DSH 服务版本");
    host.progress(runId, id, current.status === "queued" ? "Cloud DSH 文本改写排队中" : "Cloud DSH 正在修改文本");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (host.isStopped(runId) || !result) return;
  const payload = result.snapshot.events.find(event => event.type === "text.result")?.display_payload;
  if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim()) throw new Error("Cloud DSH 未返回有效的改写文本，请检查任务结果或服务版本");
  outputs = { text: agentResultValue(payload.text) };
  }
  outputs = routeAgentOutputs(outputs, outputTargets, orderedAssets.map(asset => asset.id));
  const writers = agentTextWriters(node, host.document.nodes);
  if (!outputTargets.length) {
    // A wired content card is the result's home: write it now so an early stop still
    // leaves the text on the board, and never add a second "Agent 结果" card beside it.
    if (writers.length) await writeAgentText(host, runId, node, outputs.text ?? { type: "text", text: "" }, writers, halted);
    else await writeAgentResult(host, runId, node, outputs.text ?? { type: "text", text: "" }, false, halted);
  }
  if (halted()) return;
  await host.finish(runId, node, outputs);
  await emit("creative://changed", { projectId: host.projectId });
}
