import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceStudio } from "../../../src/components/VoiceStudio";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/TacticalDialogs.css";

const w = window as any;
w.calls = [];
w.snapshot = { config: { python: "C:/voice/python.exe", model: "C:/voice/model" }, voices: [], jobs: [], assets: [] };
const asset = { id: "reference", name: "参考录音", ext: "wav", store_path: "/.tmp/voice-studio/reference.wav", duration: 4, created_at: 1 };
w.environment = { phase: "ready", message: "本机配音已就绪", gpu: "NVIDIA 测试设备", directory: "C:/voice", free_bytes: 30000000000, required_bytes: 15000000000, completed_bytes: 0, total_bytes: 3000000000, can_install: true };
w.finish = () => { const job = w.snapshot.jobs[0]; job.status = "succeeded"; job.recoverable=false; job.message = "已保存到项目素材库"; job.asset_id = "output"; w.snapshot.assets.push({ ...asset, id: "output", name: "生成配音" }); };
window.addEventListener("bowerbird:save-collected-video-to-canvas", (event: Event) => { const detail=(event as CustomEvent).detail; w.canvas=detail; detail.result=Promise.resolve(); });
w.__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path, invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (command === "voice_snapshot") return structuredClone(w.snapshot);
  if (command === "voice_environment") { if (args.action === "install") { w.environment.phase="installing"; w.environment.message="正在下载声音模型"; } if (args.action === "pause") { w.environment.phase="paused"; w.environment.message="准备已暂停"; } return structuredClone(w.environment); }
  if (command === "plugin:dialog|open") return "C:/reference.wav";
  if (command === "import_files") { w.snapshot.assets = [asset]; return [asset]; }
  if (command === "get_assets_by_ids") return [asset];
  if (command === "catalog_page") return [asset];
  if (command === "voice_save") { const voice = { id: `voice-${w.snapshot.voices.length + 1}`, name: args.name, asset_id: args.assetId, reference: "/reference.wav", transcript: args.transcript }; w.snapshot.voices.push(voice); return voice; }
  if (command === "voice_start") { const id=`job-${w.snapshot.jobs.length + 1}`; w.snapshot.jobs.unshift({ id, project: args.project, text: args.text, voice_id: args.voiceId, purpose: args.preview ? "preview" : "speech", draft_key: args.preview?.draftKey ?? "", status: "running", message: "正在生成，可以关闭面板，稍后查看结果", asset_id: null }); return id; }
  if (command === "voice_cancel") { w.snapshot.jobs[0].status = "cancelled"; w.snapshot.jobs[0].message = "已取消，可以重新生成"; return; }
  if (command === "voice_configure") return;
  if (command === "voice_manage") { if (args.name === null) w.snapshot.voices=w.snapshot.voices.filter((v: any) => v.id !== args.id); else w.snapshot.voices.find((v: any) => v.id === args.id).name=args.name; return; }
  if (command === "voice_export") return;
  if (command === "voice_recover") { w.finish(); return; }
  if (command === "audio_waveform") return { sourceVersion: "fixture", duration: 4, sampleRate: 16000, channels: 1, peaks: [[-.5,.5]], framesPerPeak: 64000, totalFrames: 64000 };
  throw new Error(`Unexpected command: ${command}`);
} };
function App() { const [show, setShow] = useState(true); return <><button onClick={() => setShow(true)}>打开声音</button>{show && <VoiceStudio projectId="project-1" onPrepare={async () => { w.prepared = true; }} onClose={() => setShow(false)} />}</>; }
createRoot(document.getElementById("root")!).render(<App />);
