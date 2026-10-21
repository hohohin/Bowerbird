import { FileText, ScanLine, Upload } from "lucide-react";
import { replicationRewriteInput, type ReplicationInput, type ReplicationReference } from "../lib/videoReplication";

export const replicationTabs: { id: "analyze" | "rewrite"; label: string; description: string; icon: typeof ScanLine }[] = [
  { id: "analyze", label: "分析视频", description: "拆解镜头与画面语言", icon: ScanLine },
  { id: "rewrite", label: "改写内容", description: "按人设和规范重写分镜", icon: FileText },
];

export function ReplicationFields({ input, onChange, reference, onUpload, onPickLibrary, onPickDouyin, onSaveDefaults, disabled }: {
  input: ReplicationInput;
  onChange: (patch: Partial<ReplicationInput>) => void;
  reference: ReplicationReference | null;
  onUpload: () => void;
  onPickLibrary: () => void;
  onPickDouyin: () => void;
  onSaveDefaults: () => void;
  disabled: boolean;
}) {
  return <fieldset className="vr-fields" disabled={disabled}>
    {input.operation === "analyze" && <>
      <div className="vr-source-buttons"><button type="button" onClick={onUpload}><Upload size={16} />选择本地视频</button><button type="button" onClick={onPickLibrary}>从素材库选择</button><button type="button" onClick={onPickDouyin}>从抖音获取</button></div>
      {reference && <div className="vr-reference-info"><strong>{reference.name}</strong><span>{reference.duration.toFixed(1)} 秒</span>
        {(reference.shareText || reference.originalUrl) && <details><summary>来源详情</summary><p>{reference.shareText}</p><p>{reference.originalUrl || reference.sourceUrl}</p></details>}
      </div>}
    </>}
    {input.operation === "rewrite" && <>
      <label className="vr-field">参考文本<textarea aria-label="参考文本" rows={6} value={input.inputText ?? ""} maxLength={50000} placeholder="粘贴文本，或从分析记录带入" onChange={event => onChange({ inputText: event.target.value })} /></label>
      <label className="vr-field">改写方向<textarea aria-label="改写方向" rows={3} value={input.rewriteDirection ?? ""} maxLength={8000} placeholder="例如：换成清晨浴室场景，节奏舒缓，保留原有时长。" onChange={event => onChange({ rewriteDirection: event.target.value })} /></label>
      <details className="vr-guidelines"><summary>人设与改写规范</summary>
      <label className="vr-field">人设<textarea aria-label="人设" rows={2} value={input.persona ?? ""} maxLength={8000} onChange={event => onChange({ persona: event.target.value })} /></label>
      <label className="vr-field">改写规范<textarea aria-label="改写规范" rows={5} value={input.rules ?? ""} maxLength={16000} onChange={event => onChange({ rules: event.target.value })} /></label>
      <button type="button" className="vr-text-button" onClick={onSaveDefaults}>将人设与规范保存为默认值</button>
      </details>
      <details><summary>查看将发送给 Cloud 的内容</summary><pre className="vr-payload">{replicationRewriteInput(input)}{"\n\n【人设】\n"}{input.persona}{"\n\n【改写规范】\n"}{input.rules}</pre></details>
    </>}
  </fieldset>;
}
