import { createStore } from "zustand";
import type { ChatPaidAuthorization, ChatPaidQuote } from "./localChat";

type PaidQuote = Extract<ChatPaidQuote, { available: true }>;
export type WorkflowChatQuote = { cardCount: number; models: { quote: PaidQuote; turns: number }[] };
type ChatPayment = { quote: PaidQuote; workflow?: never } | { workflow: WorkflowChatQuote; quote?: never };

export class ChatPaymentCancelled extends Error {}

export const chatPaidConfirmation = createStore<{
  pending: (ChatPayment & { resolve: (accepted: boolean) => void }) | null;
}>(() => ({ pending: null }));

export function confirmChatPayment(quote: PaidQuote): Promise<boolean> {
  return confirmPayment({ quote });
}

export function confirmWorkflowChatPayment(workflow: WorkflowChatQuote, signal: AbortSignal): Promise<boolean> {
  return confirmPayment({ workflow }, signal);
}

function confirmPayment(payment: ChatPayment, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (chatPaidConfirmation.getState().pending) throw new Error("请先处理正在确认的云端对话费用。");
  return new Promise(resolve => {
    const abort = () => finishChatPaymentConfirmation(false);
    signal?.addEventListener("abort", abort, { once: true });
    chatPaidConfirmation.setState({ pending: { ...payment, resolve: accepted => {
      signal?.removeEventListener("abort", abort);
      resolve(accepted);
    } } });
  });
}

export function finishChatPaymentConfirmation(accepted: boolean) {
  const { pending } = chatPaidConfirmation.getState();
  chatPaidConfirmation.setState({ pending: null });
  pending?.resolve(accepted);
}

export function chatPaymentAuthorization({ account_id, model, pricing_version, max_credits, max_output_tokens }: PaidQuote): ChatPaidAuthorization {
  return { account_id, model, pricing_version, max_credits, max_output_tokens };
}
