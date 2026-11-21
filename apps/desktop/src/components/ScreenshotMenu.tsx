import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Camera } from "lucide-react";
import { notifyError } from "../lib/notify";
import { ContextMenu } from "./ContextMenu";
import { ScreenshotHistoryPanel } from "./ScreenshotHistoryPanel";

export function ScreenshotMenu() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);

  function run(command: "screenshot_start" | "screenshot_paste") {
    setOpen(false);
    void invoke(command).catch(error => notifyError(error, "截图操作未完成，请重试。"));
  }

  return <>
    <button ref={trigger} type="button" className="app-button-dark" title="截图工具" aria-label="截图工具"
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Camera size={16} aria-hidden="true" />
    </button>
    {open && trigger.current && <ContextMenu anchor={trigger.current} label="截图工具" onClose={() => setOpen(false)}>
      <button type="button" role="menuitem" className="app-context-item" onClick={() => run("screenshot_start")}>立即截图</button>
      <button type="button" role="menuitem" className="app-context-item" onClick={() => run("screenshot_paste")}>贴出剪贴板图片</button>
      <button type="button" role="menuitem" className="app-context-item" onClick={() => { setOpen(false); setHistory(true); }}>历史截图</button>
    </ContextMenu>}
    {history && <ScreenshotHistoryPanel onClose={() => { setHistory(false); trigger.current?.focus(); }} />}
  </>;
}
