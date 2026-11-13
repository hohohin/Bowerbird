import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { VideoControls } from "../../../src/components/creation/VideoControls";
import { DreaminaTaskCredit } from "../../../src/components/creation/DreaminaCredits";
import { DEFAULT_VIDEO_OPTIONS } from "../../../src/lib/videoGeneration";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.calls = [];
w.balance = 9434;
w.cost = 240;
w.fail = false;
w.store = useStore;
useStore.setState({ cloudAuth: { logged_in: true, cloud_available: true } as any, cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } } as any, dreaminaHealth: { ok: true } });
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (w.fail) throw "模拟网络错误";
  if (command === "dreamina_credit_balance") return w.balance;
  if (command === "dreamina_task_credit") {
    if (args.submitId === "slow") return new Promise(resolve => { w.resolveSlow = resolve; });
    return w.cost;
  }
  if (command === "dreamina_video_models") throw "建卡不应查询模型能力";
  throw `Unexpected IPC ${command}`;
} };
function Preview() {
  const [mount, setMount] = useState(0);
  w.remount = () => setMount(value => value + 1);
  const [options, setOptions] = useState(DEFAULT_VIDEO_OPTIONS);
  const [channel, setChannel] = useState<"jimeng" | "cloud">("jimeng");
  const [bill, setBill] = useState({ submitId: "first", busy: false });
  w.setBill = setBill;
  w.options = options;
  w.setOptions = setOptions;
  w.channel = channel;
  return <main className="m-3 rounded border border-edge bg-panel p-3 text-ink">
    <div className="flex flex-wrap gap-2"><VideoControls key={mount} options={options} onChange={(value, nextChannel) => { setOptions(value); if (nextChannel) setChannel(nextChannel); }} channel={channel}
      ratio="16:9" onRatioChange={() => {}} /></div>
    <div className="mt-4"><DreaminaTaskCredit {...bill} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
