import { userErrorMessage } from "../lib/userError";
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { localClassification, type ClassificationLabel } from "../lib/localClassification";

export function classificationOrigin(label: ClassificationLabel) {
  switch (label.provenance?.kind) {
    case "cloud": return "Cloud 补充";
    case "library": return "来自主库规则";
    case "local": return "本地模型发现";
    default: return "来源未记录";
  }
}

export function ClassificationLabelDetails({ label, root }: { label: ClassificationLabel; root?: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!label.provenance?.asset_id);
  const [error, setError] = useState("");
  const origin = label.provenance;
  useEffect(() => {
    let active = true;
    if (!origin?.asset_id) return;
    setLoading(true); setError(""); setPreview(null);
    void localClassification.source(label.id, root ?? null).then(value => { if (active) setPreview(value); })
      .catch(error => { if (active) setError(String(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [label.id, root, origin?.asset_id]);
  return <section aria-label={`${label.name}标签详情`} className="classification-label-details space-y-2 rounded-lg border border-edge bg-panel2/50 p-3">
    <p className="font-medium">{label.name} · {classificationOrigin(label)}</p>
    {label.description && <p className="whitespace-pre-wrap break-words text-xs">{label.description}</p>}
    {!origin && <p className="text-xs text-muted">此标签没有保存创建来源，无法确定最初来自哪张图片。</p>}
    {origin?.kind === "library" && <p className="text-xs text-muted">从主库复制的分类规则，文件夹内新增标签保留在当前文件夹。</p>}
    {origin?.asset_id && <>
      <p className="text-xs break-words">创建来源图片：{origin.asset_name || origin.asset_id}</p>
      {loading ? <p role="status" className="text-xs text-muted">正在读取来源图片…</p>
        : preview ? <img src={convertFileSrc(preview)} alt={`创建「${label.name}」的来源图片：${origin.asset_name || origin.asset_id}`}
          className="max-h-64 max-w-full rounded object-contain" onError={() => setPreview(null)} />
          : <p className="text-xs text-muted">来源图片预览不可用，图片可能已移除、变更或暂时离线。</p>}
      {origin.reason && <p className="text-xs whitespace-pre-wrap break-words">新增理由：{origin.reason}</p>}
    </>}
    {origin?.created_at ? <p className="text-xs text-muted">{origin.kind === "library" ? "复制" : "创建"}时间：{new Date(origin.created_at * 1000).toLocaleString()}</p> : null}
    {error && <p role="alert" className="text-xs text-red-400">{userErrorMessage(error, "标签来源暂时无法读取，请重新打开后重试。")}</p>}
  </section>;
}
