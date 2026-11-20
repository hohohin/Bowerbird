import { createStore } from "zustand";
import type { ChatPaidQuote } from "./localChat";

type PaidQuote = Extract<ChatPaidQuote, { available: true }>;

export class ChatPaymentCancelled extends Error {}

export const chatPaidConfirmation = createStore<{
  pending: { quote: PaidQuote; resolve: (accepted: boolean) => void } | null;
}>(() => ({ pending: null }));

export function confirmChatPayment(quote: PaidQuote): Promise<boolean> {
  if (chatPaidConfirmation.getState().pending) throw new Error("请先处理正在确认的云端对话费用。");
  return new Promise(resolve => chatPaidConfirmation.setState({ pending: { quote, resolve } }));
}

export function finishChatPaymentConfirmation(accepted: boolean) {
  const { pending } = chatPaidConfirmation.getState();
  chatPaidConfirmation.setState({ pending: null });
  pending?.resolve(accepted);
}
