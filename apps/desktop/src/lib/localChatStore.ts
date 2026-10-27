import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { localChat, LOCAL_CHAT_UPDATED_EVENT, localChatInputError, localChatRunning, type ChatConversation, type ChatSummary, type LocalChatSendInput } from "./localChat";

export interface LocalChatDraft { text: string; referenceAssetIds: string[] }
const DRAFT_STORAGE = "bowerbird.localChat.drafts.v1";
const EMPTY_DRAFT: LocalChatDraft = { text: "", referenceAssetIds: [] };
function readDrafts(): Record<string, LocalChatDraft> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFT_STORAGE) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && typeof value.text === "string"
      && Array.isArray(value.referenceAssetIds) && value.referenceAssetIds.every((id: unknown) => typeof id === "string")));
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
  send: (input: Omit<LocalChatSendInput, "requestId"> & { requestId?: string }) => Promise<ChatConversation>;
  stop: (conversationId: string) => Promise<void>;
  setDraft: (conversationId: string, draft: LocalChatDraft) => void;
}

let eventSubscription: Promise<void> | null = null;
/** One subscription for the application lifetime: closing a panel must not stop a reply. */
export function ensureLocalChatEvents(): Promise<void> {
  if (!eventSubscription) {
    eventSubscription = listen<ChatConversation>(LOCAL_CHAT_UPDATED_EVENT, event => {
      useLocalChatStore.getState().applyConversation(event.payload);
    }).then(() => undefined).catch(error => { eventSubscription = null; throw error; });
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
    return { conversations: { ...state.conversations, [conversation.id]: conversation },
      summaries: { ...state.summaries, [conversation.id]: conversation },
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
        const chat = await localChat.get(conversationId);
        if (chat) get().applyConversation(chat);
        return chat;
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
  send: async input => {
    const key = input.conversationId || `new:${input.projectId}`;
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
      const fingerprint = JSON.stringify([input.projectId, input.conversationId ?? null, input.text, input.referenceAssetIds, input.cardDefaults ?? null]);
      const pending = pendingSubmissions.get(key);
      const requestId = input.requestId || (pending?.fingerprint === fingerprint ? pending.requestId : crypto.randomUUID());
      pendingSubmissions.set(key, { fingerprint, requestId });
      const chat = await localChat.send({ ...input, requestId });
      get().applyConversation(chat);
      pendingSubmissions.delete(key);
      return get().conversations[chat.id] ?? chat;
    } catch (error) {
      set(state => ({ errors: { ...state.errors, [key]: error } }));
      throw error;
    } finally { set(state => ({ sending: { ...state.sending, [key]: false } })); }
  },
  stop: async conversationId => {
    const chat = await localChat.stop(conversationId);
    if (chat) get().applyConversation(chat);
  },
  setDraft: (conversationId, draft) => {
    const drafts = { ...get().drafts };
    if (!draft.text && !draft.referenceAssetIds.length) delete drafts[conversationId];
    else drafts[conversationId] = draft;
    saveDrafts(drafts);
    set({ drafts });
  },
}));

export function localChatDraft(conversationId: string): LocalChatDraft {
  return useLocalChatStore.getState().drafts[conversationId] ?? EMPTY_DRAFT;
}
