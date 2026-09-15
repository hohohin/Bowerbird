import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { notifyError } from "../lib/notify";
import appIcon from "../../src-tauri/icons/32x32.png";

/** 窗口控制独立于工作区，加载中及打开弹窗时仍可操作。 */
export function WindowTitlebar() {
  const [maximized, setMaximized] = useState(false);
  // macOS uses its native title bar and traffic lights (tauri.macos.conf.json).
  const nativeTitlebar = /Mac/i.test(navigator.platform);

  useEffect(() => {
    if (!isTauri() || nativeTitlebar) return;
    const appWindow = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void appWindow.isMaximized().then(value => {
        if (alive) setMaximized(value);
      }).catch(error => console.error("读取窗口状态失败", error));
    };
    sync();
    void appWindow.onResized(sync).then(stop => {
      if (alive) unlisten = stop;
      else stop();
    }).catch(error => console.error("监听窗口状态失败", error));
    return () => { alive = false; unlisten?.(); };
  }, [nativeTitlebar]);

  if (!isTauri() || nativeTitlebar) return null;

  function control(action: "minimize" | "toggleMaximize" | "close" | "startDragging") {
    void getCurrentWindow()[action]().catch(error => notifyError(error, "窗口操作失败"));
  }

  return <div className="app-window-titlebar" aria-label="窗口标题栏">
    <div className="app-window-drag-region" onMouseDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      control(event.detail === 2 ? "toggleMaximize" : "startDragging");
    }}>
      <img src={appIcon} alt="园丁鸟" width={18} height={18} draggable={false} className="mr-2 shrink-0" />
      <span>Bowerbird</span>
    </div>
    <div className="app-window-controls" role="group" aria-label="窗口控制">
      <button type="button" title="最小化" aria-label="最小化窗口" onClick={() => control("minimize")}>
        <Minus size={15} aria-hidden />
      </button>
      <button type="button" title={maximized ? "还原" : "最大化"} aria-label={maximized ? "还原窗口" : "最大化窗口"}
        onClick={() => control("toggleMaximize")}>
        {maximized ? <Copy size={13} aria-hidden /> : <Square size={13} aria-hidden />}
      </button>
      <button type="button" className="app-window-close" title="关闭" aria-label="关闭窗口" onClick={() => control("close")}>
        <X size={16} aria-hidden />
      </button>
    </div>
  </div>;
}
