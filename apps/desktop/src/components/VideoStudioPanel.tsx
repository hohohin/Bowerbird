import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { userErrorMessage } from "../lib/userError";
import { notifyError } from "../lib/notify";
import { ModalShell } from "./ModalShell";
import "./VideoStudioPanel.css";

let operations: Promise<unknown> = Promise.resolve();
function queueStudio(operation: () => Promise<void>) {
  const result = operations.then(operation, operation);
  operations = result.catch(() => {});
  return result;
}

export function VideoStudioPanel({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const editorSessionId = crypto.randomUUID();
    const element = viewport.current!;
    let alive = true, opened = false, frame = 0;
    const bounds = () => {
      const rect = element.getBoundingClientRect();
      return { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(240, rect.width), height: Math.max(180, rect.height) };
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!alive || !opened) return;
        const panel = element.closest('[role="dialog"]');
        const obscured = document.hidden || [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
          .some(dialog => dialog !== panel && !dialog.contains(panel) && dialog.getClientRects().length > 0);
        void queueStudio(() => alive ? api.agentVideoStudioResize(requestId, editorSessionId, bounds(), !obscured) : Promise.resolve()).catch(cause => { if (alive) setError(cause); });
      });
    };
    const observer = new ResizeObserver(resize); observer.observe(element);
    const overlays = new MutationObserver(resize); overlays.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", resize);
    void queueStudio(() => alive ? api.agentVideoStudioOpen(requestId, editorSessionId, bounds()) : Promise.resolve()).then(() => {
      opened = true;
      if (alive) { setReady(true); resize(); }
      else void queueStudio(() => api.agentVideoStudioClose(requestId, editorSessionId)).catch(cause => notifyError(cause, "视频编辑器未能关闭"));
    }).catch(cause => { if (alive) setError(cause); });
    return () => {
      alive = false; cancelAnimationFrame(frame); observer.disconnect(); overlays.disconnect();
      window.removeEventListener("resize", resize); document.removeEventListener("visibilitychange", resize);
      // Close can cancel native startup immediately; the token excludes later panels.
      void api.agentVideoStudioClose(requestId, editorSessionId).catch(cause => notifyError(cause, "视频编辑器未能关闭"));
    };
  }, [requestId]);
  return <ModalShell title="视频编辑 · HyperFrames Studio" onClose={onClose} width="lg" className="video-studio-panel">
    {!!error && <p role="alert">{userErrorMessage(error, "视频编辑器暂时无法打开，请关闭后重试。")}</p>}
    <div ref={viewport} className="video-studio-viewport" aria-label="视频编辑器">
      {!ready && !error && <span role="status">正在打开视频工程…</span>}
    </div>
  </ModalShell>;
}
