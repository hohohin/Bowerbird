import { invoke } from "@tauri-apps/api/core";
export { canvasChatId } from "./canvasChat";

export type LocalChatStatus = "idle" | "running" | "stopping" | "stopped" | "interrupted" | "failed";
export type ChatProvider = "codex-local" | "deepseek-cloud";
export const CHAT_PROVIDER_LABELS = { "codex-local": "本机 Codex", "deepseek-cloud": "DeepSeek · Cloud" } as const;
export interface ChatComposeRequest { prompt: string; references: import("./types").Asset[]; provider: ChatProvider }
export interface ChatQuote { provider: "deepseek-cloud"; service: "chat_deepseek"; available: boolean; unit_cost: number | null; currency: "Bcoin"; pricing_version: number | null }
export function chatProviderUnavailable(provider: ChatProvider, state: {
  cloudAvailable: boolean; loggedIn: boolean; cloudAllowed: boolean; localAllowed: boolean; codexReady: boolean; balance: number;
}, quote: ChatQuote | null): string | null {
  if (provider === "codex-local") return !state.localAllowed ? "本机 Codex 对话需要 Pro 或 Studio，请在账号中查看权益。"
    : !state.codexReady ? "本机 Codex 暂未就绪，请在设置中安装并登录后继续。" : null;
  if (!state.cloudAvailable) return "当前版本未配置 Bowerbird Cloud。";
  if (!state.loggedIn) return "请先登录 Bowerbird 账号。";
  if (!state.cloudAllowed) return "当前账号暂不可使用 Cloud。";
  if (!quote) return "正在获取 Cloud 对话报价，请稍候。";
  if (!quote.available || quote.unit_cost !== 0) return "DeepSeek Cloud 对话暂未开放。";
  return state.balance < quote.unit_cost ? "Bcoin 不足，请补充后重试。" : null;
}
export interface ChatSummary {
  id: string;
  projectId: string;
  threadId: string;
  nodeId: string;
  title: string;
  provider: ChatProvider;
  status: LocalChatStatus;
  turnCount: number;
  preview: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}
export interface ChatMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  referenceAssetIds: string[];
  status: "running" | "done" | "stopped" | "interrupted" | "failed";
  createdAt: number;
  updatedAt: number;
}
export interface ChatCardAction {
  id: string; conversationId: string; turnId: string; callId: string;
  status: "created" | "undone";
  cards: { alias: string; id: string; kind: "generation" | "comfy-video" | "content" | "trigger" | "loop" | "section"; title: string }[];
  createdAt: number; undoneAt: number | null;
}
export interface ChatCardDefaults {
  provider: string;
  videoChannel: "jimeng" | "cloud";
  videoOptions: import("./videoGeneration").VideoOptions;
}
export interface ChatConversation extends ChatSummary { messages: ChatMessage[]; actions?: ChatCardAction[] }
export interface LocalChatSendInput {
  projectId: string;
  provider?: ChatProvider;
  conversationId?: string | null;
  requestId: string;
  text: string;
  referenceAssetIds: string[];
  cardDefaults?: ChatCardDefaults;
  placement?: { x: number; y: number; width: number; height: number; zIndex: number };
}
export const LOCAL_CHAT_UPDATED_EVENT = "local-chat://updated";
export const LOCAL_CHAT_CARDS_CHANGED_EVENT = "local-chat://cards-changed";
export const LOCAL_CHAT_MAX_REFERENCES = 8;
export function localChatInputError(text: string, referenceAssetIds: string[]): string | null {
  if (!text.trim()) return "请先输入要发送的消息。";
  if (new TextEncoder().encode(text).length > 100_000) return "消息内容过长，请分成几条消息发送。";
  if (new Set(referenceAssetIds).size > LOCAL_CHAT_MAX_REFERENCES) return "每条消息最多添加 8 张参考图，请移除部分图片后继续。";
  return null;
}
export const localChat = {
  quote: () => invoke<ChatQuote>("local_chat_quote"),
  list: (projectId: string) => invoke<ChatSummary[]>("local_chat_list", { projectId }),
  get: (conversationId: string) => invoke<ChatConversation | null>("local_chat_get", { conversationId }),
  send: (input: LocalChatSendInput) => invoke<ChatConversation>("local_chat_send", { input }),
  stop: (conversationId: string) => invoke<ChatConversation | null>("local_chat_stop", { conversationId }),
  recover: (conversationId: string) => invoke<ChatConversation>("local_chat_recover", { conversationId }),
  undoCards: (conversationId: string, actionId: string) => invoke<ChatConversation>("local_chat_cards_undo", { conversationId, actionId }),
};

export function localChatRunning(chat: Pick<ChatSummary, "status"> | null | undefined): boolean {
  return chat?.status === "running" || chat?.status === "stopping";
}
export function localChatStatusLabel(status: LocalChatStatus): string {
  return ({ idle: "已回复", running: "正在回复", stopping: "正在停止", stopped: "已停止", interrupted: "回复已中断", failed: "回复未完成" })[status] ?? "等待回复";
}
/** Compact card/history copy; the original message remains unchanged. */
export function localChatPreview(text: string): string {
  return text.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}|>|[-*+])\s+/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ").trim();
}
