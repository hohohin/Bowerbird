import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../../src/lib/api";
import { VideoStudioPanel } from "../../../src/components/VideoStudioPanel";
import "../../../src/styles.css";
import "../../../src/components/TacticalDialogs.css";
import "../../../src/components/IndustrialTheme.css";
const calls: unknown[] = [];
(window as unknown as { studioCalls: unknown[] }).studioCalls = calls;
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") || "dark";
api.agentVideoStudioOpen = async (id, session, bounds) => {
  calls.push(["open", id, session, bounds]);
  if (params.has("failure")) throw new Error("视频编辑器未能启动，请检查工程后重试");
  const frame = document.createElement("iframe");
  frame.src = params.get("studio")!; frame.title = "HyperFrames Studio";
  frame.style.cssText = "width:100%;height:100%;border:0;position:absolute;inset:0";
  const viewport = document.querySelector<HTMLElement>(".video-studio-viewport")!;
  viewport.style.position = "relative"; viewport.append(frame);
};
api.agentVideoStudioResize = async (id, session, bounds, visible) => { calls.push(["resize", id, session, bounds, visible]); };
api.agentVideoStudioClose = async (id, session) => { calls.push(["close", id, session]); };
function Fixture() {
  const [open, setOpen] = useState(true);
  return <main><button onClick={() => setOpen(true)}>打开视频工程</button>{open && <VideoStudioPanel requestId="studio-fixture" onClose={() => setOpen(false)} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
