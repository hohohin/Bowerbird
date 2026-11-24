import { api } from "./api";
import { profileExtractionIssue, profileInputKey } from "./workflowProviderIssue";
import { useStore } from "../store";
import { WorkflowNodeError } from "./workflowDiagnostics";
import { describeBrandImage } from "./describeBrandImage";
import { type WorkflowNode, type WorkflowStep } from "./canvasWorkflow";
import type { WorkflowExecutionHost } from "./workflowExecutionHost";

export async function executeVisualProfile(host: WorkflowExecutionHost, runId: string, node: WorkflowNode,
  step: WorkflowStep, assetIds: string[], prompt: string) {
  const id = node.id;
  const inputKey = profileInputKey(assetIds, prompt);
  let profileId = node.profileId || step.profileId || (node.profileCache?.inputKey === inputKey ? node.profileCache.profileId : undefined);
  if (!profileId) {
    if (step.status !== "pending") throw new Error("上次提炼状态未知，请检查已有规范后选择版本，或停止后重新提炼");
    const issue = profileExtractionIssue(useStore.getState());
    if (issue) throw new WorkflowNodeError(issue.message, node);
    if (prompt.length > 4000) throw new Error("视觉要求不能超过 4000 字");
    const missing = await api.visualProfileInputPreview(assetIds, prompt);
    if (host.isStopped(runId)) return;
    await host.step(runId, id, { status: "running" });
    const abort = new AbortController();
    host.registerProfileAbort(runId, abort);
    for (const assetId of missing) {
      if (host.isStopped(runId)) return;
      if (host.run(runId).accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
      await describeBrandImage(assetId, abort.signal);
    }
    if (host.isStopped(runId)) return;
    if (host.run(runId).accountId !== (useStore.getState().cloudAuth?.user_id ?? null)) throw new Error("账号已切换，请停止后重试");
    const profile = await api.visualProfileExtractInputs(`${host.projectId}:${node.id}`, node.profileName?.trim() || "画板视觉规范", assetIds, prompt);
    if (host.isStopped(runId)) return;
    profileId = profile.id;
    await host.save({ ...host.document, nodes: host.document.nodes.map(n => n.id === id ? { ...n, profileCache: { inputKey, profileId: profile.id } } : n) });
    if (host.isStopped(runId)) return;
  }
  const profile = await api.visualProfileGet(profileId);
  if (profile.status === "archived") throw new Error("此视觉规范已删除，请停止后选择其他版本");
  if (profile.status !== "confirmed") {
    await host.step(runId, id, { status: "waiting", profileId, error: "请查看并保存规范，再继续下游" });
    if (useStore.getState().activeProjectId === host.projectId) useStore.getState().openVisualProfile({ id: profile.folderId, name: profile.name, profileId });
    return;
  }
  await host.finish(runId, node, { "visual-profile": { type: "visual-profile", profileId, version: profile.version, summary: profile.summary } });
}
