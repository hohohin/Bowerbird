import { useStore } from "zustand";
import { DSH_MODELS } from "../lib/localChat";
import { chatPaidConfirmation, finishChatPaymentConfirmation } from "../lib/localChatPaid";
import { ConfirmDialog } from "./ConfirmDialog";

export function ChatPaidConfirmation() {
  const pending = useStore(chatPaidConfirmation, state => state.pending);
  if (!pending) return null;
  const { quote } = pending;
  const name = DSH_MODELS.find(model => model.model === quote.model)?.displayName ?? quote.model;
  const rate = (nano: number) => (nano / 1_000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  return <ConfirmDialog open title="确认云端对话费用" confirmLabel="授权并发送"
    onConfirm={() => finishChatPaymentConfirmation(true)} onCancel={() => finishChatPaymentConfirmation(false)}
    message={<>
      {name} 本轮最多预留 <strong>{quote.max_credits.toLocaleString("zh-CN")} Bcoin</strong>，按实际用量结算，未使用部分退回。<br />
      每百万 Token：缓存命中 {rate(quote.rates_nano.cache_hit)}、未命中 {rate(quote.rates_nano.cache_miss)}、输出 {rate(quote.rates_nano.output)} Bcoin。<br />
      单次模型调用最多输出 {quote.max_output_tokens.toLocaleString("zh-CN")} Token。未满 1 Bcoin 的费用累计到后续结算。
    </>} />;
}
