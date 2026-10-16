import { Clapperboard, FileText, ScanLine, Upload } from "lucide-react";
import { REPLICATION_RATIOS, type ReplicationInput, type ReplicationOperation, type ReplicationProduct, type ReplicationReference } from "../lib/videoReplication";

export const replicationTabs: { id: ReplicationOperation; label: string; description: string; icon: typeof ScanLine }[] = [
  { id: "analyze", label: "分析视频", description: "拆解镜头与画面语言", icon: ScanLine },
  { id: "rewrite", label: "改写内容", description: "按人设和规范重写分镜", icon: FileText },
  { id: "generate", label: "复刻视频", description: "确认提示词后生成", icon: Clapperboard },
];

export function ReplicationFields({ input, onChange, products, reference, onUpload, onPickLibrary, onPickDouyin, onSaveDefaults, disabled }: {
  input: ReplicationInput;
  onChange: (patch: Partial<ReplicationInput>) => void;
  products: ReplicationProduct[];
  reference: ReplicationReference | null;
  onUpload: () => void;
  onPickLibrary: () => void;
  onPickDouyin: () => void;
  onSaveDefaults: () => void;
  disabled: boolean;
}) {
  const productField = <label className="vr-field">目标产品{input.operation === "rewrite" && <span className="vr-muted">（可选）</span>}
    <select value={input.product?.id ?? ""} onChange={event => onChange({ product: products.find(product => product.id === event.target.value) ?? null })}>
      <option value="">{input.operation === "rewrite" ? "不指定产品" : "选择目标产品"}</option>
      {products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
    </select>
    {input.product && <small>{input.product.description}</small>}
  </label>;
  return <fieldset className="vr-fields" disabled={disabled}>
    <label className="vr-field">标题<input value={input.title} maxLength={100} onChange={event => onChange({ title: event.target.value })} /></label>
    {input.operation === "analyze" && <>
      <div className="vr-source-buttons"><button type="button" onClick={onUpload}><Upload size={16} />选择本地视频</button><button type="button" onClick={onPickLibrary}>从素材库选择</button><button type="button" onClick={onPickDouyin}>从抖音获取</button></div>
      {reference ? <div className="vr-reference-info"><strong>{reference.name}</strong><span>{reference.duration.toFixed(1)} 秒</span>
        {reference.shareText && <p>{reference.shareText}</p>}
        {reference.sourceUrl && <p>分享链接：{reference.sourceUrl}</p>}
        {reference.originalUrl && <p>作品链接：{reference.originalUrl}</p>}
      </div> : <div className="vr-empty"><ScanLine size={28} /><strong>从一段参考视频开始</strong><p>提取主体、动作、运镜、构图、光线和转场。<br />最长 120 秒，最大 200 MiB。</p></div>}
      <p className="vr-hint">分析仅输出分镜文本，不要求选择产品。生成视频需要另行确认。</p>
    </>}
    {input.operation === "rewrite" && <>
      <label className="vr-field">待改写文本<textarea rows={7} value={input.inputText ?? ""} maxLength={50000} placeholder="粘贴文本，或从分析记录带入" onChange={event => onChange({ inputText: event.target.value })} /></label>
      {productField}
      <label className="vr-field">人设<textarea rows={2} value={input.persona ?? ""} maxLength={8000} onChange={event => onChange({ persona: event.target.value })} /></label>
      <label className="vr-field">改写规范<textarea rows={5} value={input.rules ?? ""} maxLength={16000} onChange={event => onChange({ rules: event.target.value })} /></label>
      <button type="button" className="vr-text-button" onClick={onSaveDefaults}>将人设与规范保存为默认值</button>
    </>}
    {input.operation === "generate" && <>
      {productField}
      <label className="vr-field">生成提示词<textarea rows={9} value={input.prompt ?? ""} maxLength={12000} onChange={event => onChange({ prompt: event.target.value })} /><small>{[...(input.prompt ?? "")].length} / 12000 字</small></label>
      <div className="vr-field-row"><label className="vr-field">时长（秒）<input type="number" min={4} max={12} step={1} value={input.duration ?? 5} onChange={event => onChange({ duration: Number(event.target.value) })} /></label>
        <label className="vr-field">画幅<select value={input.ratio ?? "9:16"} onChange={event => onChange({ ratio: event.target.value })}>{REPLICATION_RATIOS.map(ratio => <option key={ratio}>{ratio}</option>)}</select></label>
        <label className="vr-field">分辨率<input value="720p" readOnly /></label></div>
      <label className="vr-field">场景<input value={input.scenes?.join("，") ?? ""} placeholder="用逗号分隔" onChange={event => onChange({ scenes: event.target.value.split(/[,，]/) })} /></label>
      <label className="vr-field">产品卖点<input value={input.sellingPoints?.join("，") ?? ""} placeholder="用逗号分隔" onChange={event => onChange({ sellingPoints: event.target.value.split(/[,，]/) })} /></label>
      <label className="vr-field">关键词标签<input value={input.tags?.join("，") ?? ""} placeholder="用逗号分隔" onChange={event => onChange({ tags: event.target.value.split(/[,，]/) })} /></label>
      <div className="vr-hint"><span className="vr-tag">#ai生成</span> 入库时固定保留</div>
      <p className="vr-hint">仅发送你确认的提示词。产品资料与参考视频不会自动附加到生成请求。</p>
    </>}
  </fieldset>;
}
