import { cloudTextRunError } from "./userError";
import { h3DraftForResult, h3OriginalPrompt, h3PromptPatch, H3_VIDEO_AUDIO_PORT, H3_R2V_INPUT_PORTS, type WorkflowNode, type WorkflowStep, type WorkflowValue } from "./canvasWorkflow";
import { api } from "./api";
import { emit } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { canStartAnotherAgentRun, canUseAgentRun } from "./entitlement";
import { WorkflowInputError, WorkflowNodeError } from "./workflowDiagnostics";
import { canUseComfyVideo, comfyEnvironment, comfyVideo, comfyVideoElapsed, comfyVideoMode, DEFAULT_COMFY_VIDEO, h3R2VInputError, type ComfyVideoInput, type ComfyVideoStatus } from "./comfyVideo";
import { imageOptimizationText, restoreImageOptimization, restoreH3VideoAudioReference, restoreH3R2VReferences, h3R2VPromptReferences, cleanH3OptimizedPrompt, h3OptimizationInstruction } from "./h3PromptOptimization";
import type { WorkflowExecutionHost, CardStart } from "./workflowExecutionHost";

export async function resolveComfyPromptOptimization(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, start?: CardStart) {
  const id = node.id, originalStep = host.run(runId).steps[id];
  const composedImage = !!originalStep.comfyAutoGeneration?.imageInput;
  const assertAccount = () => {
    const account = useStore.getState();
    if (host.run(runId).accountId !== (account.cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后继续，或停止此工作流");
    if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 需要有效的 Pro／Studio 权益或测试账号资格");
    return account;
  };
  assertAccount();
  let snapshot = originalStep.comfyOptimization;
  if (!snapshot) throw new Error("缺少本次优化输入，请重新点击优化提示词");
  if (!snapshot.result) {
    let terminalFailure = false;
    try {
      let agentRunId = originalStep.agentRunId;
      if (!agentRunId) {
        if (snapshot.submissionStarted) throw new Error("提示词优化提交状态未知，请核对 Agent 任务记录；不会自动重复提交");
        const account = assertAccount();
        if (!account.cloudEntitlement?.is_test_account || !canUseAgentRun(account.cloudEntitlement, "bowerbird-unified-agent")) throw new Error("当前账号尚未开放 Cloud DSH，请使用已获授权的测试账号");
        const active = Object.values(account.cloudAgentRuns).filter(run => !["succeeded", "failed", "cancelled"].includes(run.status)).length;
        if (!canStartAnotherAgentRun(account.cloudEntitlement, active, "bowerbird-unified-agent")) throw new Error("Agent 并发已满，请等待当前任务结束");
        const source = "referenceCount" in snapshot.input ? imageOptimizationText(snapshot.input.prompt, composedImage) : snapshot.input.prompt;
        if (composedImage && source.length > 16000) throw new Error("包含引用标记的提示词超出自动优化的长度限制，请删减后重试");
        snapshot = { ...snapshot, instruction: h3OptimizationInstruction(snapshot.input), submissionStarted: true };
        await host.step(runId, id, { status: "running", comfyOptimization: snapshot, error: undefined, detail: "提交 H3 提示词优化" });
        if (halted()) return;
        if (start && !start.current()) { await host.stopBeforeDispatch(runId); return; }
        start?.release();
        const created = await api.cloudAgentStart({ intentPrompt: snapshot.instruction, textRewrite: { source }, references: [],
          projectId: host.projectId, threadId: host.run(runId).threadId, imageProvider: "cloud", skillId: "bowerbird-unified-agent", agentRuntime: "dsh" });
        if (host.isStopped(runId)) { await api.cloudAgentCancel(created.runId); return; }
        agentRunId = created.runId;
        await host.step(runId, id, { agentRunId, detail: "Cloud DSH 正在优化提示词" });
      }
      while (!halted()) {
        assertAccount();
        const current = await api.cloudAgentGet(agentRunId);
        if (halted()) return;
        assertAccount();
        useStore.getState().openCloudAgentRun(current, { navigate: false });
        if (["failed", "cancelled"].includes(current.status)) { terminalFailure = true; throw cloudTextRunError(current.snapshot.run, "提示词优化未完成，请检查 Agent 任务记录"); }
        if (current.status.startsWith("awaiting_")) { terminalFailure = true; throw new Error("云端未按文本优化模式执行，请检查 Cloud DSH 服务版本"); }
        if (current.status === "succeeded") {
          terminalFailure = true;
          const payload = current.snapshot.events.find(event => event.type === "text.result")?.display_payload;
          if (payload?.schemaVersion !== 1 || typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 16000) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
          const restored = "referenceCount" in snapshot.input ? restoreImageOptimization(snapshot.input.prompt, payload.text, composedImage) : null;
          const cleaned = restored?.text ?? cleanH3OptimizedPrompt(payload.text);
          const autoInput = originalStep.comfyAutoGeneration?.input;
          const hasAudio = autoInput ? !!autoInput.audioAssetId : !!node.inputs[H3_VIDEO_AUDIO_PORT]?.length;
          const prompt = "mode" in snapshot.input && snapshot.input.mode === "r2v"
            ? restoreH3R2VReferences(snapshot.input.prompt, cleaned, snapshot.input)
            : hasAudio && "mode" in snapshot.input && snapshot.input.mode === "reference"
              ? restoreH3VideoAudioReference(snapshot.input.prompt, cleaned) : cleaned;
          if (!prompt) throw new Error("Cloud DSH 未返回有效的优化提示词，请检查任务结果");
          snapshot = { ...snapshot, result: prompt, keptOriginal: restored?.keptOriginal ?? (prompt !== cleaned ? true : undefined),
            ...(payload.dshContinuation === true ? { dshContinuation: true } : {}) };
          // Save the result before applying it so recovery never repeats the paid request.
          await host.step(runId, id, { comfyOptimization: snapshot });
          break;
        }
        host.progress(runId, id, current.status === "queued" ? "提示词优化排队中" : "Cloud DSH 正在优化提示词");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      if (halted()) return;
      if (terminalFailure || !host.run(runId).steps[id].agentRunId) throw error;
      await host.step(runId, id, { status: "waiting", error: `${String(error)}。可继续查询原优化任务，或停止此工作流。` });
      return;
    }
  }
  if (halted() || !snapshot.result) return;
  assertAccount();
  if ("referenceCount" in snapshot.input && snapshot.result.trim() === snapshot.input.prompt.trim()) {
    const reason = snapshot.keptOriginal ? "优化结果未保留完整的素材引用，已保留原提示词。" : "本次优化返回了相同的提示词，已保留原文。";
    throw new Error(reason + (composedImage ? "可重新运行，或关闭自动优化后使用原提示词生成。" : "可点击重试优化。"));
  }
  return { ...snapshot, result: snapshot.result };
}

export async function runComfyPromptOptimization(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, start?: CardStart) {
  const snapshot = await resolveComfyPromptOptimization(host, runId, node, halted, start);
  if (!snapshot || halted()) return;
  const id = node.id;
  const run = host.run(runId);
  await host.saveRun({ ...run, steps: { ...run.steps, [id]: { ...run.steps[id], status: "done", error: undefined, detail: snapshot.keptOriginal ? "优化结果的卡片引用不完整，已保留原提示词" : "提示词已替换" } } },
    host.document.nodes.map(item => item.id === id ? { ...item, ...h3PromptPatch(h3DraftForResult(snapshot.input, snapshot.result, h3OriginalPrompt(item))) } : item));
}

export async function applyAutoOptimizedDraft(host: WorkflowExecutionHost, runId: string, id: string, result: string) {
  const run = host.run(runId);
  const step = run.steps[id];
  const snapshot = step.comfyOptimization;
  if (!snapshot?.inputBindings) return;
  const current = host.document.nodes.find(node => node.id === id);
  if (!current) return;
  const original = h3OriginalPrompt(current);
  // A text port can provide the entire optimizer input. Keep the card's own source empty in that case.
  const changes = h3PromptPatch(h3DraftForResult(original.trim() ? snapshot.input : { ...snapshot.input, prompt: original }, result, original));
  const input = step.generationRunInput;
  if (current.prompt === result && input?.prompt === result && JSON.stringify(current.h3Prompt) === JSON.stringify(changes.h3Prompt)) return;
  await host.saveRun(input ? { ...run, steps: { ...run.steps, [id]: { ...step, generationRunInput: { ...input, prompt: result } } } } : run,
    host.document.nodes.map(node => node.id === id ? { ...node, ...changes } : node));
}

export async function runComfyAutoGeneration(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, video: ComfyVideoInput, start?: CardStart, linkedText = "", generationRunInput?: WorkflowStep["generationRunInput"]) {
  if (!host.run(runId).steps[node.id].comfyOptimization) {
    const mode = comfyVideoMode(video);
    const draft = node.prompt.trim();
    const input = { prompt: draft || linkedText || video.prompt, mode, seconds: video.seconds, ratio: video.ratio,
      firstFrameCount: video.firstFrame ? 1 : 0, lastFrameCount: video.lastFrame ? 1 : 0,
      ...(mode === "r2v" ? h3R2VPromptReferences(video) : { audioReference: video.audioAssetId ? true as const : undefined }) };
    await host.step(runId, node.id, { generationRunInput, comfyAutoGeneration: { input: video, videoText: draft ? linkedText : "" },
      comfyOptimization: { input, instruction: h3OptimizationInstruction(input), createdAt: Date.now(),
        inputBindings: JSON.stringify([node.inputs, node.promptReferences]) } });
  }
  if (halted()) return;
  const optimized = await resolveComfyPromptOptimization(host, runId, node, halted, start);
  if (!optimized || halted()) return;
  await applyAutoOptimizedDraft(host, runId, node.id, optimized.result);
  if (halted()) return;
  const text = host.run(runId).steps[node.id].comfyAutoGeneration?.videoText;
  let prompt = text ? `${text}\n\n${optimized.result}` : optimized.result;
  if (video.audioAssetId && comfyVideoMode(video) === "reference" && !prompt.includes("<Audio 1>")) prompt += "\n<Audio 1>";
  await runComfyVideo(host, runId, node, halted, { ...video, prompt });
}

export async function runComfyVideo(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, input?: ComfyVideoInput, start?: CardStart, generationRunInput?: WorkflowStep["generationRunInput"]) {
  const id = node.id, step = host.run(runId).steps[id], accountId = host.run(runId).accountId;
  const optimizedForThisRun = !!(step.comfyAutoGeneration?.input && step.comfyOptimization?.result);
  let jobId = step.jobId;
  let result: ComfyVideoStatus;
  let terminalFailure = false;
  const prepare = async (endpoint: string, mode: import("./comfyVideo").ComfyVideoMode, recovery?: { installation?: string | null }) => {
    let environment = await comfyEnvironment(recovery ? "recover" : "prepare", endpoint, undefined, recovery?.installation ?? undefined, mode);
    while (!halted()) {
      if (accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请登录原账号后重新运行");
      if (environment.phase === "ready") return environment.endpoint;
      if (environment.phase !== "starting" && environment.phase !== "installing") throw new Error(environment.message);
      host.progress(runId, id, environment.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (halted()) break;
      environment = await comfyEnvironment("status", endpoint, undefined, undefined, mode);
    }
    return null;
  };
  try {
    if (!jobId) {
      if (step.status !== "pending" && !optimizedForThisRun) {
        throw new Error("上次提交状态未知，请核对本机 ComfyUI 队列");
      }
      if (!input) throw new Error("缺少本地视频输入");
      host.progress(runId, id, "正在准备本机环境…");
      const endpoint = await prepare(input.endpoint, comfyVideoMode(input));
      if (!endpoint || halted()) return;
      input = { ...input, endpoint };
      jobId = crypto.randomUUID();
      await host.step(runId, id, { status: "running", jobId, error: undefined, detail: "正在提交本机视频工作流",
        generationRunInput: generationRunInput ?? step.generationRunInput });
      if (halted()) return;
      if (start && !start.current()) { await host.stopBeforeDispatch(runId); return; }
      if (accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) {
        await host.step(runId, id, { status: "pending", jobId: undefined, error: "账号已切换，请登录原账号后继续生成。" });
        return;
      }
      start?.release();
      result = await comfyVideo("start", host.projectId, jobId, input);
    } else {
      await host.step(runId, id, { status: "running", error: undefined });
      result = await comfyVideo("status", host.projectId, jobId);
    }
    let restarted = false;
    while (!halted()) {
      if (accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) {
        await host.step(runId, id, { status: "waiting", error: "请登录原账号后继续取回视频" }); return;
      }
      if (result.status === "offline") {
        if (restarted || !result.originalService) throw new Error("本机视频服务仍无法连接，原任务记录已保留。");
        restarted = true;
        const [original, mode, installation] = result.originalService;
        const endpoint = await prepare(original, mode, { installation });
        if (!endpoint || halted()) return;
        if (endpoint !== original) throw new Error("原任务使用的本机视频服务暂不可用。");
        result = await comfyVideo("status", host.projectId, jobId);
        if (result.status === "unknown") {
          terminalFailure = true;
          throw new Error("本机视频服务已恢复，未找到上次任务的结果。可以点击运行重新生成。");
        }
        continue;
      }
      if (result.status === "done" && result.asset) {
        await host.deliverMediaAsset(host.run(runId), node, result.asset, halted);
        if (halted()) return;
        await host.step(runId, id, { detail: comfyVideoElapsed(result.elapsedMs) ? `视频已生成 · 用时 ${comfyVideoElapsed(result.elapsedMs)}` : "视频已生成", error: undefined, comfyProgress: undefined });
        await host.finish(runId, node, { image: { type: "image", assetIds: [result.asset.id] } });
        await emit("creative://changed", { projectId: host.projectId }); return;
      }
      if (result.status === "failed") { terminalFailure = true; throw new Error(result.message); }
      if (result.status === "cancelled") {
        await host.step(runId, id, { comfyCancelled: true, comfyProgress: undefined });
        terminalFailure = true; throw new Error(result.message);
      }
      if (result.status === "unknown") { await host.step(runId, id, { status: "waiting", error: result.message }); return; }
      host.progress(runId, id, result.message, result.progress ?? undefined);
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (halted()) return;
      result = await comfyVideo("status", host.projectId, jobId);
    }
  } catch (error) {
    if (halted()) return;
    if (!jobId && optimizedForThisRun) {
      await host.step(runId, id, { status: "waiting", detail: "提示词已优化，等待本机生成", error: `${String(error)}。继续时会沿用本次优化结果。` });
      return;
    }
    if (terminalFailure || !jobId) throw error;
    // Preserve the durable identity on all transport errors. Continue never submits anew.
    await host.step(runId, id, { status: "waiting", comfyProgress: undefined, error: `${String(error)}。可继续查询原任务，或点击停止取消本机生成。` });
  }
}

export async function executeComfy(host: WorkflowExecutionHost, runId: string, node: WorkflowNode,
  step: WorkflowStep, halted: () => boolean, { values, localVideoMode, referenceImages, prompt, linkedText, generationRunInput, start }: {
    values: Record<string, WorkflowValue[]>;
    localVideoMode: ReturnType<typeof comfyVideoMode> | undefined;
    referenceImages: string[] | undefined;
    prompt: string;
    linkedText: string;
    generationRunInput: WorkflowStep["generationRunInput"];
    start: CardStart | undefined;
  }) {
  const account = useStore.getState();
  if (!canUseComfyVideo(account.cloudAuth, account.cloudEntitlement)) throw new Error("本地 H3 视频需要有效的 Pro／Studio 权益或测试账号资格");
  const first = (values["first-frame"] ?? []).flatMap(value => value.assetIds ?? []);
  const last = (values["last-frame"] ?? []).flatMap(value => value.assetIds ?? []);
  const audioBindings = localVideoMode === "r2v" ? [] : node.inputs[H3_VIDEO_AUDIO_PORT] ?? [];
  const audio = (values[H3_VIDEO_AUDIO_PORT] ?? []).flatMap(value => value.assetIds ?? []);
  if (audioBindings.length && (audioBindings.length !== 1 || audio.length !== 1)) {
    throw new WorkflowInputError("请连接一段可用的本地录音", node, audioBindings[0]);
  }
  const options = node.comfyVideo ?? DEFAULT_COMFY_VIDEO;
  const mode = comfyVideoMode(options);
  const referenceVideos = mode === "r2v" ? (values[H3_R2V_INPUT_PORTS.video] ?? []).flatMap(value => value.assetIds ?? []) : undefined;
  const referenceAudios = mode === "r2v" ? (values[H3_R2V_INPUT_PORTS.audio] ?? []).flatMap(value => value.assetIds ?? []) : undefined;
  const referenceError = mode === "r2v" && h3R2VInputError(referenceImages?.length ?? 0, referenceVideos?.length ?? 0, referenceAudios?.length ?? 0);
  if (referenceError) throw new WorkflowNodeError(referenceError, node);
  if (mode === "frames" && (first.length !== 1 || last.length > 1)) throw new Error("请连接一张首帧，尾帧最多一张");
  if (mode === "reference" && first.length !== 1) throw new Error("单图模式需要连接一张参考图");
  const localPrompt = mode === "reference" && audio.length && !prompt.includes("<Audio 1>") ? `${prompt}\n<Audio 1>` : prompt;
  if (!prompt || localPrompt.length > 16000) throw new Error("请填写 1–16000 字提示词");
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 15) throw new Error("视频时长需为 1–15 秒");
  const input: ComfyVideoInput = { ...options, firstFrame: mode === "text" || mode === "r2v" ? "" : first[0], lastFrame: mode === "frames" ? last[0] : undefined, prompt: localPrompt,
    ...(mode === "r2v" ? { referenceImages, referenceVideos, referenceAudios } : audio.length ? { audioAssetId: audio[0] } : {}) };
  if (step.comfyAutoGeneration) await runComfyAutoGeneration(host, runId, node, halted, input, start, linkedText, generationRunInput);
  else await runComfyVideo(host, runId, node, halted, input, start, generationRunInput);
}
