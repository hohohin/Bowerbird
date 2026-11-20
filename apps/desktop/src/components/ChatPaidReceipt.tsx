import { useState } from "react";
import { localChat, type ChatPaidReceipt as Receipt } from "../lib/localChat";
import { userErrorMessage } from "../lib/userError";
import { useStore } from "../store";

function feeLabel(nano?: string): string | null {
  if (!nano || !/^\d{1,30}$/.test(nano)) return null;
  const fee = BigInt(nano);
  if (fee > 0n && fee < 10_000_000n) return "<0.01";
  const cents = (fee + 5_000_000n) / 10_000_000n;
  const integer = (cents / 100n).toLocaleString("zh-CN");
  const remainder = cents % 100n;
  return remainder ? `${integer}.${String(remainder).padStart(2, "0")}` : integer;
}

export function ChatPaidReceipt(props: { conversationId: string; turnId: string }) {
  const account = useStore(state => state.cloudAuth?.user_id);
  return <ReceiptControl key={account ?? "signed-out"} {...props} />;
}

function ReceiptControl({ conversationId, turnId }: { conversationId: string; turnId: string }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const read = async () => {
    setPending(true); setError(null); setReceipt(null);
    try {
      const value = await localChat.paidReceipt(conversationId, turnId);
      if (value) setReceipt(value);
      else setError("本轮费用回执暂不可用。");
    } catch (reason) {
      setError(userErrorMessage(reason, "费用回执暂不可用，请重试。"));
    } finally { setPending(false); }
  };
  let summary: string | null = null;
  if (receipt?.status === "pending") summary = "费用结算中";
  if (receipt?.status === "refunded") summary = receipt.refund_credits === undefined ? "已退款" : `已退回 ${receipt.refund_credits} Bcoin`;
  if (receipt?.status === "settled") {
    const fee = feeLabel(receipt.fee_nano);
    const carry = feeLabel(receipt.carry_nano);
    summary = [fee === null ? "本轮费用待核对" : `本轮费用 ${fee} Bcoin`,
      receipt.debited_credits === undefined ? null : `本次扣除 ${receipt.debited_credits} Bcoin`,
      carry === null ? null : `结转余数 ${carry} Bcoin`].filter(Boolean).join(" · ");
  }
  return <>
    <button type="button" disabled={pending} onClick={() => void read()}>{pending ? "读取中…" : receipt ? "刷新费用回执" : "查看费用回执"}</button>
    <small aria-live="polite">{error ?? summary}</small>
  </>;
}
