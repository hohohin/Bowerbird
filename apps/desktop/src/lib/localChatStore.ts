import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import { selectedChatOptions } from "./chatCapabilities";
import { parseChatProvider } from "./chatProvider";
import { DSH_MODELS, localChat, LOCAL_CHAT_UPDATED_EVENT, localChatInputError, localChatRunning, type ChatCodexOptions, type ChatConversation, type ChatPaidAuthorization, type ChatSummary, type LocalChatSendInput } from "./localChat";
import { ChatPaymentCancelled, confirmChatPayment } from "./localChatPaid";

export interface LocalChatDraft { text: string; referenceAssetIds: string[]; codexOptions?: ChatCodexOptions }
const DRAFT_STORAGE = "bowerbird.localChat.drafts.v1";
const EMPTY_DRAFT: LocalChatDraft = { text: "", referenceAssetIds: [] };
function readDrafts(): Record<string, LocalChatDraft> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFT_STORAGE) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && typeof value.text === "string"
      && Array.isArray(value.referenceAssetIds) && value.referenceAssetIds.every((id: unknown) => typeof id === "string"))
      .map(([id, { text, referenceAssetIds, codexOptions }]) => [id, { text, referenceAssetIds, codexOptions }]));
  } catch { return {}; }
}
function saveDrafts(drafts: Record<string, LocalChatDraft>) {
  try { localStorage.setItem(DRAFT_STORAGE, JSON.stringify(drafts)); } catch { /* Keep this window's draft when storage is full. */ }
}

interface LocalChatState {
  summaries: Record<string, ChatSummary>;
  conversations: Record<string, ChatConversation>;
  projectIds: Record<string, string[]>;
  loadingProjects: Record<string, boolean>;
  loadingConversations: Record<string, boolean>;
  sending: Record<string, boolean>;
  errors: Record<string, unknown>;
  drafts: Record<string, LocalChatDraft>;
  applyConversation: (conversation: ChatConversation) => void;
  loadProject: (projectId: string) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<ChatConversation | null>;
  send: (input: Omit<LocalChatSendInput, "requestId"> & { requestId?: string }, confirmPaid?: boolean) => Promise<ChatConversation>;
  stop: (conversationId: string, turnId?: string) => Promise<void>;
  recover: (conversationId: string) => Promise<void>;
  setDraft: (conversationId: string, draft: LocalChatDraft) => void;
}

interface TextUpdate {
  conversationId: string; messageId: string; revision: number; updatedAt: number;
  offset: number; replace: boolean; text: string; preview: string;
}
const missingRevision = new Map<string, number>();
const pinned = new Map<string, number>();

export function pinLocalChat(id: string) {
  pinned.set(id, (pinned.get(id) ?? 0) + 1);
  return () => {
    const count = (pinned.get(id) ?? 1) - 1;
    if (count) pinned.set(id, count);
    else {
      pinned.delete(id);
      useLocalChatStore.setState(state => ({ conversations: trimConversations(state.conversations) }));
    }
  };
}

function trimConversations(conversations: Record<string, ChatConversation>) {
  const completed = Object.values(conversations).filter(chat => !pinned.has(chat.id) && !localChatRunning(chat));
  if (completed.length <= 16) return conversations;
  const result = { ...conversations };
  for (const oldest of completed.slice(0, completed.length - 16)) delete result[oldest.id];
  return result;
}

function asSummary({ messages, actions, submittedTurnId, vpsHistoryStartTurnId, ...summary }: ChatConversation): ChatSummary {
  return summary;
}

function receiveText(update: TextUpdate) {
  const id = update.conversationId;
  const state = useLocalChatStore.getState();
  const chat = state.conversations[id];
  if (chat && chat.revision >= update.revision) return;
  const index = chat?.messages.findIndex(message => message.id === update.messageId) ?? -1;
  if (!chat || chat.revision + 1 !== update.revision || index < 0 || chat.messages[index].text.length !== update.offset) {
    missingRevision.set(id, Math.max(missingRevision.get(id) ?? 0, update.revision));
    void state.loadConversation(id).catch(() => {});
    return;
  }
  const messages = chat.messages.slice();
  const previous = messages[index];
  messages[index] = { ...previous, updatedAt: update.updatedAt, text: update.replace ? update.text : previous.text + update.text };
  state.applyConversation({ ...chat, messages, preview: update.preview, revision: update.revision });
}

function sameCanvasChatSummaries(previous: Record<string, ChatSummary>, next: Record<string, ChatSummary>) {
  const ids = Object.keys(previous);
  return ids.length === Object.keys(next).length && ids.every(id => {
    const before = previous[id], after = next[id];
    if (before === after) return true;
    if (!before || !after) return false;
    const { preview: _beforePreview, revision: _beforeRevision, ...beforeLayout } = before;
    const { preview: _afterPreview, revision: _afterRevision, ...afterLayout } = after;
    return shallow(beforeLayout, afterLayout);
  });
}

export function useProjectChatSummaries(projectId: string | null, canvasLayoutOnly = false) {
  return useLocalChatStore(state => Object.fromEntries((projectId ? state.projectIds[projectId] ?? [] : [])
    .map(id => [id, state.summaries[id]] as const)), canvasLayoutOnly ? sameCanvasChatSummaries : shallow);
}

let eventSubscription: Promise<void> | null = null;
/** One subscription for the application lifetime: closing a panel must not stop a reply. */
export function ensureLocalChatEvents(): Promise<void> {
  if (!eventSubscription) {
    eventSubscription = (async () => {
      const stop = await listen<ChatConversation>(LOCAL_CHAT_UPDATED_EVENT, event => {
        useLocalChatStore.getState().applyConversation(event.payload);
      });
      try { await listen<TextUpdate>("local-chat://text", event => receiveText(event.payload)); }
      catch (error) { stop(); throw error; }
    })().catch(error => { eventSubscription = null; throw error; });
  }
  return eventSubscription;
}
const loadingProjects = new Map<string, Promise<void>>();
const loadingConversations = new Map<string, Promise<ChatConversation | null>>();
const pendingSubmissions = new Map<string, { fingerprint: string; requestId: string }>();
function addProjectId(projectIds: Record<string, string[]>, chat: ChatSummary): Record<string, string[]> {
  const ids = projectIds[chat.projectId] ?? [];
  return ids.includes(chat.id) ? projectIds : { ...projectIds, [chat.projectId]: [...ids, chat.id] };
}

export const useLocalChatStore = create<LocalChatState>((set, get) => ({
  summaries: {}, conversations: {}, projectIds: {}, loadingProjects: {}, loadingConversations: {}, sending: {}, errors: {}, drafts: readDrafts(),
  applyConversation: conversation => set(state => {
    // Events may arrive before an earlier IPC response; an older snapshot never rewinds a reply.
    const previous = state.conversations[conversation.id];
    const summary = state.summaries[conversation.id];
    if ((previous && previous.revision >= conversation.revision) || (summary && summary.revision > conversation.revision)) return state;
    const conversations = { ...state.conversations };
    delete conversations[conversation.id];
    conversations[conversation.id] = conversation;
    return { conversations: trimConversations(conversations),
      summaries: { ...state.summaries, [conversation.id]: asSummary(conversation) },
      projectIds: addProjectId(state.projectIds, conversation), errors: { ...state.errors, [conversation.id]: null } };
  }),
  loadProject: projectId => {
    const pending = loadingProjects.get(projectId);
    if (pending) return pending;
    set(state => ({ loadingProjects: { ...state.loadingProjects, [projectId]: true }, errors: { ...state.errors, [projectId]: null } }));
    const request = (async () => {
      try {
        await ensureLocalChatEvents();
        const chats = await localChat.list(projectId);
        set(state => {
          const summaries = { ...state.summaries };
          for (const chat of chats) if (!summaries[chat.id] || summaries[chat.id].revision <= chat.revision) summaries[chat.id] = chat;
          return { summaries, projectIds: { ...state.projectIds, [projectId]: [...new Set([...(state.projectIds[projectId] ?? []), ...chats.map(chat => chat.id)])] } };
        });
      } catch (error) {
        set(state => ({ errors: { ...state.errors, [projectId]: error } }));
        throw error;
      } finally {
        loadingProjects.delete(projectId);
        set(state => ({ loadingProjects: { ...state.loadingProjects, [projectId]: false } }));
      }
    })();
    loadingProjects.set(projectId, request);
    return request;
  },
  loadConversation: conversationId => {
    const pending = loadingConversations.get(conversationId);
    if (pending) return pending;
    set(state => ({ loadingConversations: { ...state.loadingConversations, [conversationId]: true }, errors: { ...state.errors, [conversationId]: null } }));
    const request = (async () => {
      try {
        await ensureLocalChatEvents();
        // A gap can arrive while a previous IPC snapshot is already on its way.
        // Repeat only for a newly observed gap during this read.
        let target: number;
        let chat: ChatConversation | null;
        do {
          target = missingRevision.get(conversationId) ?? 0;
          chat = await localChat.get(conversationId);
          if (chat) get().applyConversation(chat);
        } while ((missingRevision.get(conversationId) ?? 0) > Math.max(target, get().conversations[conversationId]?.revision ?? 0));
        missingRevision.delete(conversationId);
        return get().conversations[conversationId] ?? chat;
      } catch (error) {
        set(state => ({ errors: { ...state.errors, [conversationId]: error } }));
        throw error;
      } finally {
        loadingConversations.delete(conversationId);
        set(state => ({ loadingConversations: { ...state.loadingConversations, [conversationId]: false } }));
      }
    })();
    loadingConversations.set(conversationId, request);
    return request;
  },
  send: async (input, confirmPaid = false) => {
    // An unaccepted workflow step may replay its saved input after a desktop upgrade.
    const provider = parseChatProvider(input.provider);
    if (provider && provider !== input.provider) input = { ...input, provider };
    const key = input.conversationId || JSON.stringify(
      input.agentNodeId ? ["card", input.projectId, input.agentNodeId] :
      input.requestId ? ["request", input.projectId, input.requestId] : ["composer", input.projectId]
    );
    if (!input.requestId) input = { ...input, codexOptions: selectedChatOptions(input.provider ?? "codex-local", input.codexOptions) };
    const validation = localChatInputError(input.text, input.referenceAssetIds);
    if (validation) throw new Error(validation);
    if (get().sending[key] || (input.conversationId && localChatRunning(get().summaries[input.conversationId]))) {
      throw new Error("这段对话仍在回复，请等待完成或停止后继续。");
    }
    set(state => ({ sending: { ...state.sending, [key]: true }, errors: { ...state.errors, [key]: null } }));
    try {
      await ensureLocalChatEvents();
      // Retrying an uncertain IPC result must reuse its native idempotency key.
      // An accepted response clears it so a later intentional identical message is a new turn.
      const fingerprint = JSON.stringify([input.projectId, input.conversationId ?? null, input.agentNodeId ?? null, input.provider ?? "codex-local", input.text, input.referenceAssetIds, input.cardDefaults ?? null, input.codexOptions ?? null, input.dshSkill ?? null, input.manualCardRun ?? false]);
      const pending = pendingSubmissions.get(key);
      const requestId = input.requestId || (pending?.fingerprint === fingerprint ? pending.requestId : crypto.randomUUID());
      let authorization: ChatPaidAuthorization | undefined;
      const conversation = input.conversationId ? get().summaries[input.conversationId] : undefined;
      if (confirmPaid && (input.provider ?? conversation?.provider) === "dsh-cloud") {
        if (pending?.requestId === requestId || input.requestId) {
          const previous = await localChat.getByRequest(requestId);
          if (previous) {
            get().applyConversation(previous);
            pendingSubmissions.delete(key);
            return previous;
          }
        }
        const { projectRouteRevision, cloudAuth } = useStore.getState();
        if ((await localChat.quote()).paid_available === true) {
          const model = (input.codexOptions ?? conversation?.codexOptions)?.model ?? DSH_MODELS[0].model;
          const quote = await localChat.quotePaid(model);
          if (!quote.available) throw new Error("所选模型的云端对话报价暂不可用，请重新获取。");
          if (!await confirmChatPayment(quote)) throw new ChatPaymentCancelled();
          const current = useStore.getState();
          if (current.projectRouteRevision !== projectRouteRevision || current.cloudAuth?.user_id !== cloudAuth?.user_id) {
            throw new Error("项目或账号已切换，请核对后重新发送。");
          }
          const { account_id, pricing_version, max_credits, max_output_tokens } = quote;
          authorization = { account_id, model: quote.model, pricing_version, max_credits, max_output_tokens };
        }
      }
      pendingSubmissions.set(key, { fingerprint, requestId });
      const chat = await localChat.send({ ...input, requestId }, authorization);
      get().applyConversation(chat);
      pendingSubmissions.delete(key);
      return { ...(get().conversations[chat.id] ?? chat), submittedTurnId: chat.submittedTurnId };
    } catch (error) {
      if (!(error instanceof ChatPaymentCancelled)) set(state => ({ errors: { ...state.errors, [key]: error } }));
      throw error;
    } finally { set(state => ({ sending: { ...state.sending, [key]: false } })); }
  },
  stop: async (conversationId, turnId) => {
    const chat = await localChat.stop(conversationId, turnId);
    if (chat) get().applyConversation(chat);
  },
  recover: async conversationId => {
    const chat = await localChat.recover(conversationId);
    get().applyConversation(chat);
  },
  setDraft: (conversationId, draft) => {
    const drafts = { ...get().drafts };
    if (!draft.text && !draft.referenceAssetIds.length && !draft.codexOptions) delete drafts[conversationId];
    else drafts[conversationId] = draft;
    saveDrafts(drafts);
    set({ drafts });
  },
}));

export function localChatDraft(conversationId: string): LocalChatDraft {
  return useLocalChatStore.getState().drafts[conversationId] ?? EMPTY_DRAFT;
}
