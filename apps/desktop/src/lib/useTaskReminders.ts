import { useSyncExternalStore } from "react";
import { useStore } from "../store";
import { notifyError } from "./notify";
import { readReminderReceipts, reminderStorageKey, saveReminderReceipts } from "./taskReminders";

const receiptChanged = "bowerbird:task-reminder-receipts-changed";
function subscribe(listener: () => void) {
  window.addEventListener(receiptChanged, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(receiptChanged, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useTaskReminders() {
  const libraryRoot = useStore((state) => state.settings?.library_root);
  const userId = useStore((state) => state.cloudAuth?.user_id);
  const scope = reminderStorageKey(libraryRoot, userId);
  const raw = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(scope); } catch { return null; }
  });
  let receipts = new Set<string>();
  try { receipts = readReminderReceipts({ getItem: () => raw }, scope); } catch { /* Keep reminders visible if storage is unreadable. */ }
  return {
    isCleared: (key: string | null) => key !== null && receipts.has(key),
    clear: (keys: readonly string[]) => {
      try {
        saveReminderReceipts(localStorage, scope, keys);
        window.dispatchEvent(new Event(receiptChanged));
      } catch {
        notifyError(null, "无法保存提醒清除记录，请重试");
      }
    },
  };
}
