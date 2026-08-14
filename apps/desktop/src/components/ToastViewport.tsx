import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { listenForNotices, type NoticeDetail } from "../lib/notify";

const DISMISS_AFTER_MS = 4200;

export function ToastViewport() {
  const [notices, setNotices] = useState<NoticeDetail[]>([]);

  useEffect(
    () =>
      listenForNotices((notice) => {
        setNotices((current) => [...current.slice(-2), notice]);
        window.setTimeout(() => {
          setNotices((current) => current.filter((item) => item.id !== notice.id));
        }, DISMISS_AFTER_MS);
      }),
    []
  );

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {notices.map((notice) => {
        const Icon =
          notice.tone === "success"
            ? CheckCircle2
            : notice.tone === "error"
              ? CircleAlert
              : Info;
        return (
          <div key={notice.id} className={`app-toast is-${notice.tone}`} role="status">
            <Icon size={17} strokeWidth={1.9} aria-hidden />
            <span>{notice.message}</span>
            <button
              type="button"
              onClick={() =>
                setNotices((current) => current.filter((item) => item.id !== notice.id))
              }
              aria-label="关闭通知"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
