import { useEffect, useState } from "react";
import { useAppUpdater } from "../lib/appUpdater";
import { AppUpdateCard } from "./AppUpdateCard";
import { ModalShell } from "./ModalShell";

export function StartupUpdateDialog({ ready }: { ready: boolean }) {
  const { check, startupPrompt, dismissStartupPrompt, update, phase } = useAppUpdater();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (ready) void check({ startup: true });
  }, [ready, check]);

  useEffect(() => {
    if (!ready || !startupPrompt || open) return;
    // Wait for existing dialogs (including Settings/library migration) to close.
    // The update modal then owns focus and reuses the same install/save guards.
    const showWhenUnblocked = () => {
      const blocked = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
        .some(element => !element.hasAttribute("data-project-inspector")
          && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
      if (!blocked) setOpen(true);
    };
    showWhenUnblocked();
    const observer = new MutationObserver(showWhenUnblocked);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, [ready, startupPrompt, open]);

  if (!open || !startupPrompt || !update) return null;
  const installing = phase === "installing";
  function dismiss() {
    dismissStartupPrompt();
    setOpen(false);
  }

  return (
    <ModalShell title="发现新版本" width="sm" onClose={dismiss} preventClose={installing}
      description="是否更新 Bowerbird？下载完成后，可确认安装并重启应用。"
      footer={<button type="button" className="app-modal-button" onClick={dismiss} disabled={installing}>
        {phase === "available" ? "暂不更新" : "稍后处理"}
      </button>}>
      <AppUpdateCard version={update.currentVersion} migrating={false} downloadLabel="立即更新" />
    </ModalShell>
  );
}
