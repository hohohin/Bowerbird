import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { VideoPlayer } from "../../../src/components/VideoPlayer";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/TacticalMenus.css";
import "../../../src/components/IndustrialMenus.css";
import "./preview.css";

(window as any).__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path, invoke: async () => null };
function Preview() {
  const [mode, setMode] = useState("portrait");
  const [light, setLight] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [status, setStatus] = useState("");
  document.documentElement.dataset.theme = light ? "light" : "dark";
  return <main className="video-design">
    <header><div><span className="design-mark" />BOWERBIRD <span className="design-title">视频控件</span></div>
      <nav aria-label="预览设置">{[ ["portrait", "竖屏"], ["wide", "横屏"], ["square", "方形"] ].map(([key, label]) => <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}
        <button aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>窄容器</button><button onClick={() => setLight(!light)}>{light ? "深色" : "浅色"}</button></nav></header>
    <div className={`design-stage${narrow ? " narrow" : ""}`}>
      <VideoPlayer key={mode} path={`/.tmp/video-redesign/${mode}.mp4`} frameTarget="canvas" showTrim
        onAddFrame={async frame => setStatus(`已模拟截取 ${frame.time.toFixed(2)} 秒画面，不写入素材库`)}
        onSaveTrim={async () => { setStatus("预览不覆盖原视频"); throw new Error("预览不保存视频"); }} />
    </div><p className="design-status" role="status">{status || "交互预览 · 不修改素材"}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
