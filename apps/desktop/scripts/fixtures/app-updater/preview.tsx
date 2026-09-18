import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppUpdateCard } from "../../../src/components/AppUpdateCard";
import { useAppUpdater } from "../../../src/lib/appUpdater";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

// No network, installer, real library or account access in this fixture.
const w = window as any;
w.updater = useAppUpdater;
w.store = useStore;
w.calls = [];
w.mode = "available";
w.__TAURI_INTERNALS__ = {
  transformCallback: () => 1,
  unregisterCallback: () => {},
  invoke: async (command: string, args: any) => {
    w.calls.push(command);
    if (command === "plugin:updater|check") {
      if (w.mode === "offline") throw "网络不可用";
      if (w.mode === "current") return null;
      return { rid: 1, currentVersion: "26.9.17", version: "26.9.18", body: "设置内自动更新", rawJson: {} };
    }
    if (command === "plugin:updater|download") {
      args.onEvent.onmessage({ event: "Started", data: w.unknownSize ? {} : { contentLength: 100 } });
      args.onEvent.onmessage({ event: "Progress", data: { chunkLength: 50 } });
      await new Promise<void>((resolve) => { w.finishDownload = resolve; });
      args.onEvent.onmessage({ event: "Finished" });
      if (w.badSignature) throw "签名校验失败";
      return 2;
    }
    if (command === "plugin:updater|install" && w.installFails) throw "安装程序启动失败";
    if (command === "plugin:process|restart" && w.restartFails) throw "重启失败";
    return null;
  },
};
useStore.setState({ projectCanvasFlush: async () => {
  w.calls.push("flush");
  if (w.flushFails) throw new Error("保存失败");
} });

function Fixture() {
  const [visible, setVisible] = useState(true);
  return <div className="min-h-screen bg-bg p-8 text-ink"><button onClick={() => setVisible(!visible)}>切换设置</button>
    {visible && <div className="mt-4 max-w-xl"><AppUpdateCard version="26.9.17" migrating={false} /></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
