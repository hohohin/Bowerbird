import { Coins } from "lucide-react";

export function BcoinAmount({ amount }: { amount: number }) {
  return <span className="inline-flex items-center gap-1 whitespace-nowrap align-middle">
    {amount.toLocaleString("zh-CN")}<Coins size={13} aria-hidden="true"/><span className="sr-only"> Bcoin</span>
  </span>;
}
