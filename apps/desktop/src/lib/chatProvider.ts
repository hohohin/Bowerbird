export const CHAT_PROVIDER_LABELS = {
  "codex-local": "本机 Codex",
  "dsh-local": "本机 DSH",
  "dsh-cloud": "DSH · Cloud",
} as const;
export type ChatProvider = keyof typeof CHAT_PROVIDER_LABELS;
export const CHAT_PROVIDERS = Object.keys(CHAT_PROVIDER_LABELS) as ChatProvider[];
export function isChatProvider(value: unknown): value is ChatProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHAT_PROVIDER_LABELS, value);
}
/** Read provider values from drafts, workflow documents and templates saved by older versions. */
export function parseChatProvider(value: unknown): ChatProvider | undefined {
  if (value === "deepseek-cloud") return "dsh-cloud";
  return isChatProvider(value) ? value : undefined;
}
export function chatUsesCloud(provider: ChatProvider): boolean {
  return provider === "dsh-cloud";
}
export function chatAssistantLabel(provider: ChatProvider): string {
  return provider === "codex-local" ? "Codex" : "DSH";
}
