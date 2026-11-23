import { useEffect } from "react";
import { useAppUpdater } from "../lib/appUpdater";
import { ConfirmDialog } from "./ConfirmDialog";

export function AppUpdateMonitor({ ready }: { ready: boolean }) {
  const check = useAppUpdater(s => s.check);
  const needsConfirmation = useAppUpdater(s => s.needsInstallConfirmation);

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

  return <ConfirmDialog open={needsConfirmation} title="安装并重启"
    message="目前仍有进行中的本地生成，安装新版本可能会导致生成不可取回，请确认是否要安装并重启"
    confirmLabel="安装并重启" danger
    onCancel={() => useAppUpdater.setState({ needsInstallConfirmation: false })}
    onConfirm={() => void useAppUpdater.getState().install(true)} />;
}
