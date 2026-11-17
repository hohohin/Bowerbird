import { useStore } from "zustand";
import { DSH_MODELS, selectChatCodexModel, type ChatCodexOptions } from "../../lib/localChat";
import { codexModelCatalog } from "../../lib/chatCapabilities";
import { TacticalSelect } from "../TacticalSelect";
import "./CodexModelSelect.css";

export function useChatCodexModels() {
  const { value: models, error, pending, key } = useStore(codexModelCatalog.store);
  return { models, error, loading: pending && !models, retry: () => codexModelCatalog.check(key, true) };
}

const effortLabels: Record<string, string> = { off: "关闭", max: "最高", none: "无推理", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高" };
export function CodexModelSelect({ value, onChange, catalog, disabled, provider = "codex-local" }: {
  provider?: import("../../lib/localChat").ChatProvider; value: ChatCodexOptions; onChange: (options: ChatCodexOptions) => void; catalog: ReturnType<typeof useChatCodexModels>; disabled?: boolean;
}) {
  const codex = provider === "codex-local";
  const name = codex ? "Codex" : "DSH";
  const models = codex ? catalog.models ?? [] : DSH_MODELS;
  const loading = codex && catalog.loading;
  const model = value.model ? models.find(item => item.model === value.model) : models.find(item => item.isDefault) ?? models[0];
  const efforts = model?.supportedReasoningEfforts ?? [];
  return <div className="chat-codex-options" aria-busy={loading}>
    <TacticalSelect aria-label={name + " 模型"} title={name + " 模型"} value={value.model ?? (codex ? model?.model : "") ?? ""} disabled={disabled || loading || !models.length}
      onValueChange={next => onChange(selectChatCodexModel(value, next, models))}>
      {!codex && <option value="">跟随服务配置</option>}
      {!models.length && !value.model && <option value="" disabled>{loading ? "读取模型…" : "无可用模型"}</option>}
      {value.model && !model && <option value={value.model} disabled>{value.model}</option>}
      {models.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
    </TacticalSelect>
    <TacticalSelect aria-label={name + " 推理强度"} title={name + " 推理强度"} value={value.reasoningEffort ?? (codex || value.model ? model?.defaultReasoningEffort : "") ?? ""} disabled={disabled || loading || !efforts.length}
      onValueChange={next => onChange({ model: model?.model, reasoningEffort: next })}>
      {!codex && !value.model && !value.reasoningEffort && <option value="" disabled>跟随服务配置</option>}
      {!efforts.length && !value.reasoningEffort && <option value="" disabled>{loading ? "读取中…" : "无可选强度"}</option>}
      {value.reasoningEffort && !efforts.some(item => item.reasoningEffort === value.reasoningEffort) && <option value={value.reasoningEffort} disabled>{effortLabels[value.reasoningEffort] ?? value.reasoningEffort}</option>}
      {efforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabels[item.reasoningEffort] ?? item.reasoningEffort}</option>)}
    </TacticalSelect>
    {codex && catalog.error && <button type="button" className="chat-codex-retry" onClick={catalog.retry} disabled={disabled} title={catalog.error}>重试模型列表</button>}
  </div>;
}
