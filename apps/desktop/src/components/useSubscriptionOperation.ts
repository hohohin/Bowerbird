import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

type Operation = "check" | "auth" | "logout";

export function useSubscriptionOperation(channel: string, cancelSetup: () => Promise<void>) {
  const [busy, setBusy] = useState<Operation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [line, setLine] = useState("");
  const [failed, setFailed] = useState(false);
  const active = useRef<Operation | null>(null);
  const mounted = useRef(false);
  const cancellation = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    mounted.current = true;
    const subscription = listen<{ line: string; percent?: number }>(channel, ({ payload }) => {
      if (active.current !== "auth" || cancellation.current) return;
      setLine(typeof payload.percent === "number" ? `${payload.line}（${payload.percent}%）` : payload.line);
    });
    void subscription.catch(() => {});
    return () => {
      mounted.current = false;
      void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [channel]);

  const run = useCallback(async (kind: Operation, action: () => Promise<void>) => {
    if (active.current) return;
    active.current = kind;
    setBusy(kind);
    if (kind !== "check") setFailed(false);
    try {
      await action();
    } finally {
      if (cancellation.current) {
        const cancelled = await cancellation.current;
        setFailed(!cancelled);
        setLine(cancelled ? "已取消授权" : "未能确认取消，请重新检测登录状态。");
        cancellation.current = null;
        setCancelling(false);
      }
      active.current = null;
      setBusy(null);
    }
  }, []);

  function cancel() {
    if (active.current !== "auth" || cancellation.current) return;
    setCancelling(true);
    setLine("正在取消授权…");
    cancellation.current = cancelSetup().then(() => true, () => false);
  }

  return { active, mounted, busy, cancelling, cancellation, failed, line, setFailed, setLine, run, cancel };
}
