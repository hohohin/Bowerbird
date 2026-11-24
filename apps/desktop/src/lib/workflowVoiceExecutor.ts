import { isAudioPath } from "./audioMedia";
import { voiceApi } from "./voice";
import { defaultVoiceSample, voiceCardClip, voiceCardPreviewKey, type VoiceCardRequest } from "./voiceCard";
import { api } from "./api";
import { useStore } from "../store";
import { type WorkflowNode, type WorkflowValue } from "./canvasWorkflow";
import type { WorkflowExecutionHost } from "./workflowExecutionHost";

export async function runVoice(host: WorkflowExecutionHost, runId: string, node: WorkflowNode, halted: () => boolean, values?: Record<string, WorkflowValue[]>) {
  const run = host.run(runId);
  const voice = node.voice ?? {};
  let request: VoiceCardRequest | undefined = run.steps[node.id].voiceRequest;
  const recovering = !!request;
  if (!request) {
    const environment = await voiceApi.environment();
    if (environment.phase !== "ready") throw new Error(environment.message);
    const key = crypto.randomUUID();
    let text = [...(values?.text ?? []).map(value => value.text), node.prompt].filter(Boolean).join("\n").trim();
    let preview: Parameters<typeof voiceApi.start>[3];
    request = { key };
    if (!voice.id) {
      if (run.order.length !== 1) throw new Error("请先为角色声音卡片选择声音");
      const ids = (values?.image ?? []).flatMap(value => value.assetIds ?? []);
      if (ids.length !== 1) throw new Error("请选择一段参考录音");
      const [asset] = await api.getAssetsByIds(ids);
      if (!asset || !isAudioPath(asset.store_path)) throw new Error("请选择音频素材作为参考录音");
      const clip = voiceCardClip(voice, asset);
      text = (voice.sampleText ?? defaultVoiceSample).trim();
      request.previewKey = voiceCardPreviewKey(voice, asset);
      preview = { assetId: asset.id, start: clip.start, end: clip.end, transcript: clip.transcript, draftKey: request.previewKey };
    }
    if (!text) throw new Error(voice.id ? "请输入配音台词" : "请输入试听台词");
    if (halted()) return;
    await host.step(runId, node.id, { status: "running", voiceRequest: request, detail: voice.id ? "正在生成配音" : "正在生成试听" });
    if (halted()) return;
    let jobId: string;
    try { jobId = await voiceApi.start(host.projectId, text, voice.id ?? null, preview, key); }
    catch (error) {
      const snapshot = await voiceApi.snapshot(host.projectId).catch(() => null);
      if (!snapshot) {
        if (!halted()) await host.step(runId, node.id, { status: "waiting", error: "提交状态待确认，点击继续以查询原任务" });
        return;
      }
      const original = snapshot.jobs.find(item => item.request_key === key);
      if (!original) throw error;
      jobId = original.id;
    }
    if (halted()) { await voiceApi.cancel(jobId); return; }
    request = { ...request, jobId };
    await host.step(runId, node.id, { voiceRequest: request });
  }
  let retrySave = recovering;
  while (!halted()) {
    if (run.accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("请登录原账号后继续取回配音");
    let snapshot: Awaited<ReturnType<typeof voiceApi.snapshot>>;
    try { snapshot = await voiceApi.snapshot(host.projectId); }
    catch (error) {
      if (!halted()) await host.step(runId, node.id, { status: "waiting", error: `配音查询中断，可继续查询原任务。${String(error)}` });
      return;
    }
    if (halted()) return;
    const identity: VoiceCardRequest = request;
    const job = snapshot.jobs.find(item => item.id === identity.jobId || item.request_key === identity.key);
    if (!job) { await host.step(runId, node.id, { status: "waiting", error: "尚未找到原配音任务，可继续查询" }); return; }
    if (!request.jobId) {
      request = { ...request, jobId: job.id };
      await host.step(runId, node.id, { voiceRequest: request });
    }
    if (job.status === "succeeded") {
      const asset = snapshot.assets.find(item => item.id === job.asset_id);
      if (!asset) throw new Error("配音素材已移除");
      if (!request.previewKey) {
        try { await host.deliverMediaAsset(host.run(runId), node, asset, halted, `workflow-voice:${job.id}`); }
        catch (error) {
          if (!halted()) await host.step(runId, node.id, { status: "waiting", error: `配音已保存，点击继续添加到画板。${String(error)}` });
          return;
        }
      }
      if (halted()) return;
      await host.step(runId, node.id, { voiceRequest: { ...request, assetId: asset.id } });
      await host.finish(runId, node, request.previewKey ? {} : { image: { type: "image", assetIds: [asset.id] } });
      return;
    }
    if (job.recoverable) {
      if (retrySave) { retrySave = false; await voiceApi.recover(job.id); continue; }
      await host.step(runId, node.id, { status: "waiting", error: "音频已生成，点击继续以重试保存" });
      return;
    }
    if (job.status !== "running") throw new Error(job.message);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
