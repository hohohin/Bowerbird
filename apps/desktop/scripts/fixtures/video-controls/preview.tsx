import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { VideoControls } from "../../../src/components/creation/VideoControls";
import { DreaminaTaskCredit } from "../../../src/components/creation/DreaminaCredits";
import { DEFAULT_VIDEO_OPTIONS, cloudVideoOptions } from "../../../src/lib/videoGeneration";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.calls = [];
w.balance = 9434;
w.cost = 240;
w.fail = false;
w.store = useStore;
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (w.fail) throw "模拟网络错误";
  if (command === "dreamina_credit_balance") return w.balance;
  if (command === "dreamina_task_credit") {
    if (args.submitId === "slow") return new Promise(resolve => { w.resolveSlow = resolve; });
    return w.cost;
  }
  if (command === "dreamina_video_models") return [
    { model_version: "seedance2.5", resolutions: ["480p", "720p", "1080p"], min_duration: 4, max_duration: 30 },
    { model_version: "seedance2.0fast", resolutions: ["720p"], min_duration: 4, max_duration: 15 },
    { model_version: "seedance2.0_vip", resolutions: ["720p", "1080p", "4k"], min_duration: 4, max_duration: 15 },
    ...(args.kind === "image2video" ? [{ model_version: "seedance1.0fast", resolutions: ["720p"], min_duration: 5, max_duration: 10 }] : []),
  ];
  throw `Unexpected IPC ${command}`;
} };
function Preview() {
  const [options, setOptions] = useState(DEFAULT_VIDEO_OPTIONS);
  const [channel, setChannel] = useState<"jimeng" | "cloud">("jimeng");
  const [bill, setBill] = useState({ submitId: "first", busy: false });
  w.setBill = setBill;
  w.options = options;
  w.channel = channel;
  return <main className="m-3 rounded border border-edge bg-panel p-3 text-ink">
    <div className="flex flex-wrap gap-2"><VideoControls options={options} onChange={setOptions} channel={channel}
      onChannelChange={value => { setChannel(value); if (value === "cloud") setOptions(cloudVideoOptions(options)); }} ratio="16:9" onRatioChange={() => {}} /></div>
    <div className="mt-4"><DreaminaTaskCredit {...bill} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
