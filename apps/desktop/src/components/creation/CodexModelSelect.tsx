import { useStore } from "zustand";
import { selectChatCodexModel, type ChatCodexOptions } from "../../lib/localChat";
import { codexModelCatalog } from "../../lib/chatCapabilities";
import { TacticalSelect } from "../TacticalSelect";
import "./CodexModelSelect.css";

export function useChatCodexModels() {
  const { value: models, error, pending, key } = useStore(codexModelCatalog.store);
  return { models, error, loading: pending && !models, retry: () => codexModelCatalog.check(key, true) };
}

const effortLabels: Record<string, string> = { none: "无推理", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高" };
export function CodexModelSelect({ value, onChange, catalog, disabled }: {
  value: ChatCodexOptions; onChange: (options: ChatCodexOptions) => void; catalog: ReturnType<typeof useChatCodexModels>; disabled?: boolean;
}) {
  const models = catalog.models ?? [];
  const model = value.model ? models.find(item => item.model === value.model) : models.find(item => item.isDefault);
  const efforts = model?.supportedReasoningEfforts ?? [];
  return <div className="chat-codex-options" aria-busy={catalog.loading}>
    <TacticalSelect aria-label="Codex 模型" title="Codex 模型" value={value.model ?? ""} disabled={disabled || catalog.loading}
      onValueChange={next => onChange(selectChatCodexModel(value, next, models))}>
      <option value="">{catalog.loading ? "读取模型…" : "默认模型"}</option>
      {value.model && !model && <option value={value.model} disabled>{value.model}</option>}
      {models.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
    </TacticalSelect>
    <TacticalSelect aria-label="Codex 推理强度" title="Codex 推理强度" value={value.reasoningEffort ?? ""} disabled={disabled || catalog.loading}
      onValueChange={next => onChange({ ...(value.model ? { model: value.model } : {}), ...(next ? { reasoningEffort: next } : {}) })}>
      <option value="">默认推理</option>
      {value.reasoningEffort && !efforts.some(item => item.reasoningEffort === value.reasoningEffort) && <option value={value.reasoningEffort} disabled>{effortLabels[value.reasoningEffort] ?? value.reasoningEffort}</option>}
      {efforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabels[item.reasoningEffort] ?? item.reasoningEffort}</option>)}
    </TacticalSelect>
    {catalog.error && <button type="button" className="chat-codex-retry" onClick={catalog.retry} disabled={disabled} title={catalog.error}>重试模型列表</button>}
  </div>;
}
