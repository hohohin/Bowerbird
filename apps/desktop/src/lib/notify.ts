import { userErrorMessage } from "./userError";

export type NoticeTone = "success" | "error" | "info";

export interface NoticeDetail {
  id: number;
  message: string;
  tone: NoticeTone;
}

const NOTICE_EVENT = "bowerbird://notify";
let noticeId = 0;

export function notify(message: string, tone: NoticeTone = "info") {
  window.dispatchEvent(
    new CustomEvent<NoticeDetail>(NOTICE_EVENT, {
      detail: { id: ++noticeId, message: tone === "error" ? userErrorMessage(message) : message, tone },
    })
  );
}

export function notifySuccess(message: string) {
  notify(message, "success");
}

export function notifyError(error: unknown, fallback: string) {
  notify(userErrorMessage(error, fallback), "error");
}

export function listenForNotices(handler: (detail: NoticeDetail) => void) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<NoticeDetail>).detail;
    // Also cover producers that dispatch the event directly instead of calling notifyError.
    handler(detail.tone === "error" ? { ...detail, message: userErrorMessage(detail.message) } : detail);
  };
  window.addEventListener(NOTICE_EVENT, listener);
  return () => window.removeEventListener(NOTICE_EVENT, listener);
}
