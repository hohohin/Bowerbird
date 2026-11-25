import { useStore } from "zustand";
import { DSH_MODELS } from "../lib/localChat";
import { chatPaidConfirmation, finishChatPaymentConfirmation } from "../lib/localChatPaid";
import type { ChatPaidQuote } from "../lib/localChat";
import { ConfirmDialog } from "./ConfirmDialog";

const amount = (value: number | bigint) => value.toLocaleString("zh-CN");

function ModelRates({ quote, turns }: { quote: Extract<ChatPaidQuote, { available: true }>; turns?: number }) {
  const name = DSH_MODELS.find(model => model.model === quote.model)?.displayName ?? quote.model;
  const rate = (nano: number) => (nano / 1_000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  return <span className="block">
    {name}{turns === undefined ? " 本轮" : ` 最多 ${amount(turns)} 轮，每轮`}最多预留 <strong>{amount(quote.max_credits)} Bcoin</strong>。<br />
    每百万 Token 的缓存命中、未命中和输出费率分别为 {rate(quote.rates_nano.cache_hit)}、{rate(quote.rates_nano.cache_miss)} 和 {rate(quote.rates_nano.output)} Bcoin。<br />
    单次模型调用最多输出 {amount(quote.max_output_tokens)} Token。
  </span>;
}

export function ChatPaidConfirmation() {
  const pending = useStore(chatPaidConfirmation, state => state.pending);
  if (!pending) return null;
  const { quote, workflow } = pending;
  const max = workflow?.models.reduce((total, row) => total + BigInt(row.quote.max_credits) * BigInt(row.turns), 0n);
  return <ConfirmDialog open title={workflow ? "确认工作流云端对话费用" : "确认云端对话费用"}
    confirmLabel={workflow ? "授权并运行" : "授权并发送"}
    onConfirm={() => finishChatPaymentConfirmation(true)} onCancel={() => finishChatPaymentConfirmation(false)}
    message={<>
      {workflow && max !== undefined && <span className="mb-2 block">
        本次运行涉及 {amount(workflow.cardCount)} 张 Agent 卡片，各轮预留上限合计 <strong>{amount(max)} Bcoin</strong>。
      </span>}
      {workflow?.models.map(row => <ModelRates key={row.quote.model} {...row} />)}
      {quote && <ModelRates quote={quote} />}
      <span className="mt-2 block">按实际 Token 用量结算，未使用部分退回。未满 1 Bcoin 的费用累计到后续结算。</span>
    </>} />;
}
