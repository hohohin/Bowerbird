import { useEffect, useState } from "react";
import { localChat, selectChatCodexModel, type ChatCodexModel, type ChatCodexOptions } from "../../lib/localChat";
import { userErrorMessage } from "../../lib/userError";
import { useStore } from "../../store";
import { TacticalSelect } from "../TacticalSelect";
import "./CodexModelSelect.css";

export function useChatCodexModels(active: boolean) {
  const ready = useStore(state => !!state.codexHealth?.ok);
  const [models, setModels] = useState<ChatCodexModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setModels(null); setError(null);
    if (active && ready) localChat.models()
      .then(value => { if (!cancelled) setModels(value); })
      .catch(reason => { if (!cancelled) setError(userErrorMessage(reason, "Codex 模型列表读取失败，请重试。")); });
    return () => { cancelled = true; };
  }, [active, ready, attempt]);
  return { models, error, loading: active && ready && !models && !error, retry: () => setAttempt(value => value + 1) };
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
