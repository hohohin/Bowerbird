import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { listenForNotices, type NoticeDetail } from "../lib/notify";
import "./ToastViewport.css";

const DISMISS_AFTER_MS = 4200;

function Toast({ notice, dismiss }: { notice: NoticeDetail; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(() => dismiss(notice.id), DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [notice.id, dismiss, hovered, focused]);
  const Icon = notice.tone === "success" ? CheckCircle2 : notice.tone === "error" ? CircleAlert : Info;
  return <div className={`app-toast is-${notice.tone}`} role="status"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <Icon size={17} strokeWidth={1.9} aria-hidden />
    {notice.action ? <button type="button" className="app-toast-action"
      aria-label={`${notice.message}，${notice.action.label}`}
      onClick={() => { notice.action?.onClick(); dismiss(notice.id); }}>
      <span>{notice.message}</span><ArrowUpRight size={15} aria-hidden />
    </button> : <span>{notice.message}</span>}
    <button type="button" onClick={() => dismiss(notice.id)} aria-label="关闭通知" title="关闭"><X size={14} /></button>
  </div>;
}

export function ToastViewport() {
  const [notices, setNotices] = useState<NoticeDetail[]>([]);
  const dismiss = useCallback((id: number) => setNotices(current => current.filter(item => item.id !== id)), []);
  useEffect(() => listenForNotices(notice => {
    if (notice.channel !== "generation") setNotices(current => [...current.slice(-2), notice]);
  }), []);
  return <div className="toast-viewport" aria-live="polite" aria-atomic="false">
    {notices.map(notice => <Toast key={notice.id} notice={notice} dismiss={dismiss} />)}
  </div>;
}
