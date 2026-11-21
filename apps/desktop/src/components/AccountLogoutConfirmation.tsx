import { useLayoutEffect } from "react";
import { useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";

export function AccountLogoutConfirmation({ userId, onClose }: { userId: string; onClose: () => void }) {
  const matchesAccount = useStore(state => state.cloudAuth?.logged_in === true && state.cloudAuth.user_id === userId);
  const busy = useStore(state => state.cloudBusy);

  useLayoutEffect(() => {
    if (!matchesAccount) onClose();
  }, [matchesAccount, onClose]);

  return <ConfirmDialog open={matchesAccount} danger confirmDisabled={busy}
    title="登出 Bowerbird 账号？" message="登出后需要重新登录才能使用 Cloud 和查看 Bcoin。此设备上的素材和项目会保留。"
    confirmLabel="确认登出" onCancel={onClose} onConfirm={() => {
      const { cloudAuth, cloudBusy, logoutCloud } = useStore.getState();
      onClose();
      if (!cloudBusy && cloudAuth?.logged_in && cloudAuth.user_id === userId) void logoutCloud();
    }} />;
}
