import { api } from "./api";
import { useStore } from "../store";
import { packLayerHistory, unpackLayerHistory, type LayerWorkspace } from "./layerDocument";
import { prepareLayerReference, verifyLayerImages } from "./layerImages";
import { cloudAccountIssue } from "./generationAvailability";

const activeAssets = new Set<string>();

export async function layerDecompositionAvailable() {
  const quote = await api.layerCloudRequest({ action: "layer_quote", max_images: 30 });
  return quote.layer_protocol === 2 && !!quote.services?.some(service => service.service === "image_layer_decompose" && service.available);
}

/** Same persisted request/result contract as the editor's Start decomposition button. */
export async function workflowLayerDecompose(assetId: string, path: string, prompt: string, key: string, create: boolean, stopped: () => boolean, waitForPoll: () => Promise<boolean>, progress: (message: string) => void) {
  if (activeAssets.has(assetId)) throw new Error("这张图片正在拆分，请等待当前拆分完成");
  activeAssets.add(assetId);
  try {
    let workspace: LayerWorkspace = await api.layerWorkspaceLoad(assetId) ?? { document: null, pending: null };
    if (useStore.getState().layerEditor?.assetId === assetId) throw new Error("请先保存并退出该图的分层编辑，再运行拆分");
    if (stopped()) throw new Error("工作流已停止");
    if (workspace.document?.layers.length && !workspace.pending && !workspace.textPending) {
      progress("复用已有分层工程");
      return workspace.document;
    }
    const auth = useStore.getState().cloudAuth;
    const issue = cloudAccountIssue(auth);
    if (issue || !auth) throw new Error(issue?.message ?? "请先登录 Bowerbird 后拆分图片");
    const check = () => {
      if (stopped()) throw new Error("工作流已停止，原拆分任务可从图片右键继续取回");
      if (useStore.getState().cloudAuth?.user_id !== auth.user_id) throw new Error("账号已切换，请登录原账号取回拆分结果");
    };
    if (workspace.textPending || (workspace.pending && (workspace.pending.userId !== auth.user_id || workspace.pending.request.idempotency_key !== key))) {
      throw new Error("该图有未完成的分层任务，请从图片右键取回后再运行");
    }
    check();
    if (create && !workspace.pending) {
      progress("检查拆分服务与输入图片");
      if (!await layerDecompositionAvailable()) throw new Error("拆分服务暂不可用");
      const image = await prepareLayerReference(await api.readImageDataUrl(path), true);
      workspace = { ...workspace, pending: { userId: auth.user_id!, layerId: null, request: { idempotency_key: key, media: "image",
        service: "image_layer_decompose", prompt: prompt.trim(), reference_images: [image], layer_options: { operation: "decompose", size: "auto", max_images: 30, text_recognition: true } } } };
      progress("保存拆分任务，准备提交");
      check(); await api.layerWorkspaceSave(assetId, workspace);
    }
    check();
    progress(create ? "提交云端拆分" : "取回原拆分任务");
    let result = await api.layerCloudRequest({ action: "get_by_key", idempotency_key: key });
    check();
    if (result.status === "not_found" && create && workspace.pending) result = await api.layerCloudRequest(workspace.pending.request);
    while (["uploading", "queued", "leased", "running", "cancel_requested"].includes(result.status)) {
      progress(`云端拆分${result.status === "queued" ? "排队中" : "处理中"}${typeof result.progress === "number" ? ` · ${result.progress}%` : ""}`);
      if (!await waitForPoll()) return null;
      check();
      result = await api.layerCloudRequest({ action: "get_by_key", idempotency_key: key });
    }
    check();
    if (result.status !== "succeeded") {
      if (["failed", "cancelled", "artifact_expired", "rejected"].includes(result.status)) await api.layerWorkspaceSave(assetId, { ...workspace, pending: null });
      throw new Error(result.error?.message ?? "拆分结果尚无法确认，请从原图右键查询原任务");
    }
    const next = result.layer_result?.document;
    progress("校验图层包并保存工程");
    if (!next?.layers.length) throw new Error("云端未返回完整图层包");
    await verifyLayerImages(next.layers); check();
    const history = unpackLayerHistory(workspace);
    if (workspace.document) history.push(workspace.document);
    await api.layerWorkspaceSave(assetId, { document: next, pending: null, history: packLayerHistory(next, history) });
    useStore.setState(state => ({ layerWorkspaceIds: new Set([...state.layerWorkspaceIds, assetId]) }));
    void useStore.getState().syncCloudEntitlement();
    return next;
  } finally { activeAssets.delete(assetId); }
}
