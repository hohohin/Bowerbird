import { useRef, useState } from "react";
import { useStore } from "../store";

export function RedeemCodeCard() {
  const redeem = useStore((s) => s.redeemCloudCode);
  const cloudBusy = useStore((s) => s.cloudBusy);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (running.current || cloudBusy || !code.trim()) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const result = await redeem(code.trim());
      setCode("");
      const end = new Date(result.period_end).toLocaleDateString("zh-CN");
      const creditEnd = new Date(result.credits_expires_at).toLocaleDateString("zh-CN");
      setMessage(`${result.already_redeemed ? "此码已兑换成功，未重复发放。" : "兑换成功！"}本次兑换后 Pro 到期日：${end}；已发放 ${result.credits} 积分，有效期至 ${creditEnd}。${result.entitlement ? "" : "权益暂未同步，请点击上方「刷新权益」。"}`);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "兑换请求失败，请使用同一码重试");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="settings-card px-3 py-2.5" onSubmit={(event) => void submit(event)}>
      <label htmlFor="pro-redemption-code" className="text-ink">兑换 Pro</label>
      <p id="pro-redemption-hint" className="mt-1 text-[11px] text-muted">
        每码可兑换 1 个月 Pro 和 1100 积分。已有 Pro 时长顺延；积分到账后 30 天有效。
      </p>
      <div className="mt-2 flex gap-2">
        <input
          id="pro-redemption-code"
          aria-describedby="pro-redemption-hint"
          value={code}
          onChange={(event) => { setCode(event.target.value); setMessage(null); }}
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
          placeholder="输入兑换码"
          disabled={busy || cloudBusy}
          className="min-w-0 flex-1 rounded-md border border-edge bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
        />
        <button type="submit" disabled={busy || cloudBusy || !code.trim()}
          className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90 disabled:opacity-50">
          {busy ? "兑换中…" : "兑换"}
        </button>
      </div>
      {message && <p role={failed ? "alert" : "status"} className={`mt-2 text-xs ${failed ? "text-red-300" : "text-accent"}`}>{message}</p>}
    </form>
  );
}
