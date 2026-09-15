import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalClassificationDialog } from "../../../src/components/LocalClassificationDialog";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.calls = [];
w.failure = null;
w.classificationStatus = { supported: true, installed: false, enabled: false, busy: false, phase: "", done: 0, total: 0, failed: 0, download_done: 0, download_total: 755911809, message: "", model: "local-test" };
w.labels = [];
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (w.failure === command) throw new Error("合成错误：请重试");
  switch (command) {
    case "local_classification_status": return structuredClone(w.classificationStatus);
    case "local_classification_labels": return structuredClone(w.labels);
    case "local_classification_start":
      w.classificationStatus.busy = true; w.classificationStatus.phase = args.install ? "downloading" : "classifying";
      w.classificationStatus.message = args.install ? "正在下载 model.gguf" : "正在识别素材"; return;
    case "local_classification_stop": w.classificationStatus.busy = false; w.classificationStatus.enabled = false; w.classificationStatus.message = "已停止"; return;
    case "local_classification_enable": w.classificationStatus.enabled = args.enabled; return;
    case "local_classification_save_label": {
      const id = args.id ?? `label-${w.labels.length}`;
      const label = { ...args, id, count: 0 };
      w.labels = [...w.labels.filter((l: any) => l.id !== id), label]; return id;
    }
    case "local_classification_example": return;
    default: throw new Error(`Unexpected IPC ${command}`);
  }
} };
useStore.setState({ selectedIds: new Set(["a", "b"]) });
function App() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>打开本地分类</button>{open && <LocalClassificationDialog onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
