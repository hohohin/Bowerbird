export const CHAT_PROVIDER_LABELS = {
  "codex-local": "本机 Codex",
  "deepseek-cloud": "DeepSeek · Cloud",
  "dsh-local": "本机 DSH",
  "dsh-cloud": "DSH · Cloud",
} as const;
export type ChatProvider = keyof typeof CHAT_PROVIDER_LABELS;
export const CHAT_PROVIDERS = Object.keys(CHAT_PROVIDER_LABELS) as ChatProvider[];
export function isChatProvider(value: unknown): value is ChatProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHAT_PROVIDER_LABELS, value);
}
export function chatUsesCloud(provider: ChatProvider): boolean {
  return provider === "deepseek-cloud" || provider === "dsh-cloud";
}
export function chatAssistantLabel(provider: ChatProvider): string {
  return provider === "codex-local" ? "Codex" : provider === "deepseek-cloud" ? "DeepSeek" : "DSH";
}
