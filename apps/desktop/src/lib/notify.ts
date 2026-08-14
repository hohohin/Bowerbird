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
      detail: { id: ++noticeId, message, tone },
    })
  );
}

export function notifySuccess(message: string) {
  notify(message, "success");
}

export function notifyError(error: unknown, fallback: string) {
  let message = fallback;
  if (typeof error === "string" && error.trim()) message = error;
  else if (error instanceof Error && error.message.trim()) message = error.message;
  notify(message, "error");
}

export function listenForNotices(handler: (detail: NoticeDetail) => void) {
  const listener = (event: Event) => {
    handler((event as CustomEvent<NoticeDetail>).detail);
  };
  window.addEventListener(NOTICE_EVENT, listener);
  return () => window.removeEventListener(NOTICE_EVENT, listener);
}
