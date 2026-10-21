import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalClassificationDialog } from "../../../src/components/LocalClassificationDialog";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.getSmartFilter = () => useStore.getState().smartFilter;
w.calls = [];
w.callbacks = {};
w.listeners = {};
w.emitClassification = () => {
  for (const handler of Object.values(w.listeners) as number[]) {
    w.callbacks[handler]?.({event:"local-classification://progress",payload:structuredClone(w.classificationStatus)});
  }
};
w.failure = null;
w.classificationStatus = { supported: true, installed: false, enabled: false, busy: false, phase: "", done: 0, total: 0, failed: 0, jev_done: 0, cloud_running: 0, cloud_queued: 0, download_done: 0, download_total: 1401293979, message: "", model: "local-test", acceleration: "", vector_supported: true, vector_installed: false, current_asset: null, jev_progress: null };
w.previewAsset = { id: "preview-a", name: "柔光羊羔.png", position: 1, thumb_path: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="#95bd61"/><ellipse cx="90" cy="52" rx="40" ry="22" fill="#fff9df"/></svg>') };
w.labels = [];
w.settings = { jev_image_classification_enabled: false, jev_api_key: null };
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (event: string, id: number) => { delete w.listeners[id]; } };
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: unknown) => { const id = Object.keys(w.callbacks).length + 1; w.callbacks[id] = callback; return id; },
  unregisterCallback: (id: number) => { delete w.callbacks[id]; },
  convertFileSrc: (path: string) => path, invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (w.failure === command) throw new Error("合成错误：请重试");
  switch (command) {
    case "plugin:event|listen": w.listeners[args.handler] = args.handler; return args.handler;
    case "plugin:event|unlisten": delete w.listeners[args.eventId]; return;
    case "local_classification_status": return structuredClone(w.classificationStatus);
    case "project_classification_labels":
    case "local_classification_labels": return structuredClone(w.labels);
    case "global_classification_view": return {labels:structuredClone(w.labels),pictures:[]};
    case "folder_classification_view": return {root:args.path,record:{version:1,recursive:false,labels:structuredClone(w.labels),pictures:[]}};
    case "get_settings": return structuredClone(w.settings);
    case "update_settings": w.settings = { ...w.settings, ...args.settings }; return;
    case "project_classification_start":
    case "global_classification_start":
    case "folder_classification_start":
    case "local_classification_start":
      w.classificationStatus.run_id = crypto.randomUUID();
      w.classificationStatus.recent_results = [];
      w.classificationStatus.recent_cloud_handoffs = [];
      w.classificationStatus.jev_done = 0;
      w.classificationStatus.done = 0;
      w.classificationStatus.failed = 0;
      w.classificationStatus.last_error = "";
      w.classificationStatus.project_id = args.projectId ?? null;
      w.classificationStatus.global_scope = command === "global_classification_start";
      w.classificationStatus.folder_root = args.root ?? null;
      w.classificationStatus.model = !args.install && w.settings.jev_image_classification_enabled ? "jev-choice-flat-top4-30/cloud-discovery-v7" : "local-test";
      w.classificationStatus.current_asset = args.install ? null : structuredClone(w.previewAsset);
      if (!args.install) w.classificationStatus.total = 3;
      w.classificationStatus.jev_progress = !args.install && w.settings.jev_image_classification_enabled ? { asset: structuredClone(w.previewAsset), report: null, message: "正在等待 Jev 返回结果…" } : null;
      w.classificationStatus.busy = true; w.classificationStatus.phase = args.install ? "downloading" : "classifying";
      w.classificationStatus.message = args.install ? "正在下载 model.gguf" : "正在识别素材"; return;
    case "local_classification_stop":
      if (w.classificationStatus.jev_progress) w.classificationStatus.jev_progress.message = "已停止；此图未完成的结果未写入";
      w.classificationStatus.current_asset = null; w.classificationStatus.busy = false; w.classificationStatus.enabled = false; w.classificationStatus.message = "已停止"; return;
    case "local_classification_vector_install":
      w.classificationStatus.model = "local-test";
      w.classificationStatus.busy = true; w.classificationStatus.phase = "downloading";
      w.classificationStatus.message = "正在下载向量匹配模型（约 834 MB）"; return;
    case "local_classification_vector_uninstall":
      w.classificationStatus.vector_installed = false; w.classificationStatus.message = "向量匹配模型已卸载"; return;
    case "local_classification_enable": w.classificationStatus.enabled = args.enabled; return;
    case "local_classification_save_label": {
      const id = args.id ?? `label-${w.labels.length}`;
      const label = { ...args, id, count: 0 };
      w.labels = [...w.labels.filter((l: any) => l.id !== id), label]; return id;
    }
    case "local_classification_example": return;
    case "local_classification_delete_labels":
      w.labels = w.labels.filter((label: any) => !args.tagIds.includes(label.id)); return;
    default: throw new Error(`Unexpected IPC ${command}`);
  }
} };
useStore.setState({ selectedIds: new Set(["a", "b"]) });
function App() {
  const [open, setOpen] = useState(true);
  const params = new URLSearchParams(location.search);
  const project = params.has("project");
  return <><button onClick={() => setOpen(true)}>打开自动分类</button>{open && <LocalClassificationDialog projectId={project ? "project-test" : undefined}
    globalScope={params.has("global")} globalPaths={[]} folder={params.has("folder") ? {root:"D:/fixture",recursive:false} : undefined}
    initialView={params.size ? "labels" : "classification"} onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
