import { invoke } from "@tauri-apps/api/core";
import type { ChatProvider } from "./chatProvider";
export { CHAT_PROVIDER_LABELS, CHAT_PROVIDERS, isChatProvider, chatUsesCloud, chatAssistantLabel, type ChatProvider } from "./chatProvider";
export { canvasChatId } from "./canvasChat";

export type LocalChatStatus = "idle" | "running" | "stopping" | "stopped" | "interrupted" | "failed";
export interface ChatDshStatus { localAvailable: boolean; managedAvailable: boolean; localReason: string | null; managedReason: string | null; localUrl: string; localMode?: "auto" | "local"; localNote?: string | null }
export type ChatDshSetup = { mode: "auto" } | { mode: "local"; url?: string; authUrl?: string };
export interface ChatDshAccount {
  state: "notInstalled" | "signedOut" | "pending" | "verified" | "unverified" | "failed" | "cancelled" | "expired";
  attemptId?: string;
  authorizeUrl?: string;
  modelConfigured?: boolean;
}
export interface ChatCodexOptions { model?: string; reasoningEffort?: string }
export interface ChatCodexModel {
  id: string; model: string; displayName: string; isDefault: boolean; defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}
export const DSH_MODELS: ChatCodexModel[] = [
  { model: "deepseek-flash", displayName: "DeepSeek V4.1 Flash" },
  { model: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
].map((item, index) => ({ ...item, id: item.model, isDefault: index === 0, defaultReasoningEffort: "high",
  supportedReasoningEfforts: ["off", "low", "high", "max"].map(reasoningEffort => ({ reasoningEffort, description: "" })) }));

export function selectChatCodexModel(options: ChatCodexOptions, model: string, models: ChatCodexModel[]): ChatCodexOptions {
  if (!model) return {};
  const selected = models.find(item => item.model === model);
  const effort = selected?.supportedReasoningEfforts.some(item => item.reasoningEffort === options.reasoningEffort)
    ? options.reasoningEffort : selected?.defaultReasoningEffort;
  return { model, ...(effort ? { reasoningEffort: effort } : {}) };
}
const agentDshPreference = "bowerbird.agent.dsh-local.options";
export function rememberAgentDshOptions(options: ChatCodexOptions) {
  localStorage.setItem(agentDshPreference, JSON.stringify(options));
}
export function agentChatOptions(provider: ChatProvider, options?: ChatCodexOptions) {
  if (provider === "codex-local") return options;
  let preferred = options;
  if (provider === "dsh-local" && !options?.model) {
    try { preferred = JSON.parse(localStorage.getItem(agentDshPreference) ?? "null"); }
    catch { preferred = undefined; }
  }
  const model = DSH_MODELS.find(item => item.model === preferred?.model) ?? DSH_MODELS[0];
  return selectChatCodexModel({ reasoningEffort: options?.reasoningEffort ?? preferred?.reasoningEffort }, model.model, DSH_MODELS);
}

export function chatCodexOptionError(options: ChatCodexOptions, models: ChatCodexModel[] | null): string | null {
  if (!options.model && !options.reasoningEffort) return null;
  if (!models) return "请先读取 Codex 模型列表后发送。";
  const selected = options.model ? models.find(item => item.model === options.model) : models.find(item => item.isDefault);
  if (!selected) return "所选 Codex 模型暂不可用，请重新选择。";
  return options.reasoningEffort && !selected.supportedReasoningEfforts.some(item => item.reasoningEffort === options.reasoningEffort)
    ? "所选模型不支持此推理强度，请重新选择。" : null;
}
export interface ChatComposeRequest { prompt: string; references: import("./types").Asset[]; provider: ChatProvider; codexOptions?: ChatCodexOptions; dshSkill?: import("./dshSkill").DshSkill }
export interface ChatQuote { service: "chat_deepseek"; available: boolean; unit_cost: number | null; currency: "Bcoin"; pricing_version: number | null; dsh_vps_v2_available?: boolean; dsh_vps_skills_available?: boolean; paid_available?: boolean }
export interface ChatPaidAuthorization { account_id: string; model: string; pricing_version: number; max_credits: number; max_output_tokens: number }
export type ChatPaidQuote = { available: false } | (ChatPaidAuthorization & {
  available: true; rates_nano: { cache_hit: number; cache_miss: number; output: number };
});
export interface ChatPaidReceipt {
  status: "pending" | "settled" | "refunded";
  model: string; pricing_version: number; max_credits: number;
  fee_nano?: string; debited_credits?: number; carry_nano?: string; refund_credits?: number;
}
export function chatProviderUnavailable(provider: ChatProvider, state: {
  cloudAvailable: boolean; loggedIn: boolean; cloudAllowed: boolean; localAllowed: boolean; codexReady: boolean; balance: number;
}, quote: ChatQuote | null, dsh: ChatDshStatus | null = null): string | null {
  if (provider === "codex-local") return !state.localAllowed ? "本机 Codex 对话需要 Pro 或 Studio，请在账号中查看权益。"
    : !state.codexReady ? "本机 Codex 暂未就绪，请在设置中安装并登录后继续。" : null;
  if (provider === "dsh-local") return !state.localAllowed ? "本机 DSH 对话需要 Pro 或 Studio，请在账号中查看权益。"
    : dsh?.localAvailable ? null : dsh?.localReason ?? "请先连接本机 DSH。";
  if (!state.cloudAvailable) return "当前版本未配置 Bowerbird Cloud。";
  if (!state.loggedIn) return "请先登录 Bowerbird 账号。";
  if (!state.cloudAllowed) return "当前账号暂不可使用 Cloud。";
  if (!quote) return "正在获取 Cloud 对话报价，请稍候。";
  if (quote.paid_available === true) return null;
  if (!quote.available || quote.unit_cost !== 0 || !quote.dsh_vps_v2_available) return "云端 DSH 会话服务暂未开放。";
  return state.balance < quote.unit_cost ? "Bcoin 不足，请补充后重试。" : null;
}
export interface ChatSummary {
  id: string;
  projectId: string;
  threadId: string;
  nodeId: string;
  title: string;
  provider: ChatProvider;
  codexOptions?: ChatCodexOptions;
  status: LocalChatStatus;
  turnCount: number;
  preview: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}
export interface ChatMessage {
  dshTerminalError?: string;
  dshFailureCode?: string;
  paidCloudChat?: boolean;
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
  runStatus?: "requested" | "dispatching" | "started" | "failed" | "unknown";
  cards: { alias: string; id: string; kind: "generation" | "comfy-video" | "content" | "trigger" | "loop" | "section"; title: string }[];
  createdAt: number; undoneAt: number | null;
}
export interface ChatCardDefaults {
  provider: string;
  videoChannel: "jimeng" | "cloud";
  videoOptions: import("./videoGeneration").VideoOptions;
}
export interface ChatConversation extends ChatSummary { messages: ChatMessage[]; actions?: ChatCardAction[]; submittedTurnId?: string; vpsHistoryStartTurnId?: string }
export interface AgentQuestionBatch {
  turnId: string;
  callId: string;
  state?: "open" | "continued";
  queued?: boolean;
  questions: { id: string; question: string; options: { label: string; description?: string | null }[]; multiSelect: boolean }[];
}
export interface AgentQuestionAnswer { id: string; selected: string[]; custom?: string }
export interface LocalChatSendInput {
  projectId: string;
  dshSkill?: import("./dshSkill").DshSkill;
  provider?: ChatProvider;
  codexOptions?: ChatCodexOptions;
  conversationId?: string | null;
  agentNodeId?: string;
  manualCardRun?: true;
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
  if (new Set(referenceAssetIds).size > LOCAL_CHAT_MAX_REFERENCES) return "每条消息最多添加 8 个参考素材，请移除部分素材后继续。";
  return null;
}
export const localChat = {
  dshStatus: () => invoke<ChatDshStatus>("local_chat_dsh_status"),
  dshSetup: (input: ChatDshSetup) => invoke<ChatDshStatus>("local_chat_dsh_setup", { ...input }),
  dshAccount: (action: "status" | "start" | "cancel" | "logout", attemptId?: string) =>
    invoke<ChatDshAccount>("local_chat_dsh_account", { action, attemptId }),
  models: () => invoke<ChatCodexModel[]>("local_chat_models"),
  quote: () => invoke<ChatQuote>("local_chat_quote"),
  quotePaid: (model: string) => invoke<ChatPaidQuote>("local_chat_quote_paid", { model }),
  paidReceipt: (conversationId: string, turnId: string) => invoke<ChatPaidReceipt | null>("local_chat_paid_receipt", { conversationId, turnId }),
  list: (projectId: string) => invoke<ChatSummary[]>("local_chat_list", { projectId }),
  revision: (conversationId: string) => invoke<number | null>("local_chat_revision", { conversationId }),
  get: (conversationId: string) => invoke<ChatConversation | null>("local_chat_get", { conversationId }),
  openH3Optimization: (projectId: string, nodeId: string, workflowRunId: string) =>
    invoke<ChatConversation>("cloud_agent_open_h3_chat", { projectId, nodeId, workflowRunId }),
  newOnCard: (projectId: string, nodeId: string, conversationId: string, codexOptions?: ChatCodexOptions, provider?: ChatProvider) =>
    invoke<ChatConversation>("local_chat_new_on_card", { projectId, nodeId, conversationId, codexOptions, provider }),
  getByRequest: (requestId: string) => invoke<ChatConversation | null>("local_chat_get_by_request", { requestId }),
  send: (input: LocalChatSendInput, paidAuthorization?: ChatPaidAuthorization) =>
    invoke<ChatConversation>("local_chat_send", { input, ...(paidAuthorization ? { paidAuthorization } : {}) }),
  stop: (conversationId: string, turnId?: string) => invoke<ChatConversation | null>("local_chat_stop", { conversationId, turnId }),
  recover: (conversationId: string) => invoke<ChatConversation>("local_chat_recover", { conversationId }),
  questions: (conversationId: string) => invoke<AgentQuestionBatch[]>("local_chat_questions", { conversationId }),
  answerQuestion: (conversationId: string, turnId: string, callId: string, answers: AgentQuestionAnswer[]) =>
    invoke<void>("local_chat_answer_question", { conversationId, turnId, callId, answers }),
  undoCards: (conversationId: string, actionId: string) => invoke<ChatConversation>("local_chat_cards_undo", { conversationId, actionId }),
};

export function localChatRunning(chat: Pick<ChatSummary, "status"> | null | undefined): boolean {
  return chat?.status === "running" || chat?.status === "stopping";
}
export function localChatStatusLabel(status: LocalChatStatus, turnCount?: number): string {
  if (turnCount === 0 && status === "idle") return "等待第一条消息";
  return ({ idle: "已回复", running: "正在回复", stopping: "正在停止", stopped: "已停止", interrupted: "回复已中断", failed: "回复未完成" })[status] ?? "等待回复";
}
