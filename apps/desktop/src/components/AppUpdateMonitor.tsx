import { useEffect } from "react";
import { useAppUpdater } from "../lib/appUpdater";

export function AppUpdateMonitor({ ready }: { ready: boolean }) {
  const check = useAppUpdater(s => s.check);

  useEffect(() => {
    if (!ready) return;
    void check({ startup: true });
    const interval = 5 * 60_000;
    let lastCheck = Date.now();
    const refresh = () => {
      if (Date.now() - lastCheck < interval) return;
      lastCheck = Date.now();
      void check({ background: true });
    };
    const timer = window.setInterval(refresh, interval);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [ready, check]);

  return null;
}
