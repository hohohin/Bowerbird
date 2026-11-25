import { useStore } from "zustand";
import { Brain, Cpu, RotateCw } from "lucide-react";
import { DSH_MODELS, selectChatCodexModel, type ChatCodexOptions } from "../../lib/localChat";
import { codexModelCatalog } from "../../lib/chatCapabilities";
import { TacticalSelect } from "../TacticalSelect";
import "./CodexModelSelect.css";

export function useChatCodexModels() {
  const { value: models, error, pending, key } = useStore(codexModelCatalog.store);
  return { models, error, loading: pending && !models, retry: () => codexModelCatalog.check(key, true) };
}

const effortLabels: Record<string, string> = { off: "关闭", max: "最高", none: "无推理", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高" };
const serviceDefaultLabel = "跟随服务配置";
export function CodexModelSelect({ value, onChange, catalog, disabled, allowServiceDefault = false, provider = "codex-local", compact = false }: {
  allowServiceDefault?: boolean; provider?: import("../../lib/localChat").ChatProvider; value: ChatCodexOptions; onChange: (options: ChatCodexOptions) => void; catalog: ReturnType<typeof useChatCodexModels>; disabled?: boolean;
  compact?: boolean;
}) {
  const codex = provider === "codex-local";
  const name = codex ? "Codex" : "DSH";
  const models = codex ? catalog.models ?? [] : DSH_MODELS;
  const loading = codex && catalog.loading;
  const serviceDefault = allowServiceDefault && !codex;
  const model = value.model ? models.find(item => item.model === value.model) : models.find(item => item.isDefault) ?? models[0];
  const efforts = model?.supportedReasoningEfforts ?? [];
  const modelValue = value.model ?? (serviceDefault ? "" : model?.model) ?? "";
  const effortValue = value.reasoningEffort ?? (modelValue ? model?.defaultReasoningEffort : "") ?? "";
  const modelLabel = modelValue ? model?.displayName || modelValue : serviceDefault ? serviceDefaultLabel : loading ? "读取模型…" : "无可用模型";
  // DSH uses "off" in saved options and requests. DeepSeek calls this setting "none".
  const effortName = (effort: string) => codex ? effortLabels[effort] ?? effort : effort === "off" ? "none" : effort;
  const effortLabel = effortValue ? effortName(effortValue) : serviceDefault && !modelValue ? serviceDefaultLabel : loading ? "读取中…" : "无可选强度";
  return <div className="chat-codex-options" aria-busy={loading}>
    <TacticalSelect aria-label={name + " 模型"} title={compact ? `${name} 模型 · ${modelLabel}` : name + " 模型"} aria-description={compact ? modelLabel : undefined}
      icon={compact ? <Cpu size={13} /> : undefined} value={modelValue} disabled={disabled || loading || !models.length}
      onValueChange={next => onChange(selectChatCodexModel(value, next, models))}>
      {serviceDefault && <option value="">{serviceDefaultLabel}</option>}
      {!models.length && !value.model && <option value="" disabled>{loading ? "读取模型…" : "无可用模型"}</option>}
      {value.model && !model && <option value={value.model} disabled>{value.model}</option>}
      {models.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
    </TacticalSelect>
    <TacticalSelect aria-label={name + " 推理强度"} title={compact ? `${name} 推理强度 · ${effortLabel}` : name + " 推理强度"} aria-description={compact ? effortLabel : undefined}
      icon={compact ? <Brain size={13} /> : undefined} value={effortValue} disabled={disabled || loading || !efforts.length}
      onValueChange={next => onChange({ model: model?.model, reasoningEffort: next })}>
      {serviceDefault && !modelValue && !effortValue && <option value="" disabled>{serviceDefaultLabel}</option>}
      {!efforts.length && !value.reasoningEffort && <option value="" disabled>{loading ? "读取中…" : "无可选强度"}</option>}
      {value.reasoningEffort && !efforts.some(item => item.reasoningEffort === value.reasoningEffort) && <option value={value.reasoningEffort} disabled>{effortName(value.reasoningEffort)}</option>}
      {efforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortName(item.reasoningEffort)}</option>)}
    </TacticalSelect>
    {codex && catalog.error && <button type="button" className="chat-codex-retry" onClick={catalog.retry} disabled={disabled} title={catalog.error}
      aria-label={compact ? "重试模型列表" : undefined}>{compact ? <RotateCw size={13} aria-hidden="true" /> : "重试模型列表"}</button>}
  </div>;
}
