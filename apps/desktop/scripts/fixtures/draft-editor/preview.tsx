import React from "react";
import { createRoot } from "react-dom/client";
import { DraftEditor } from "../../../src/components/DraftEditor";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.calls = []; w.saves = []; w.exports = []; w.failSave = false; w.store = useStore;
w.openDraft = (assetId = null) => useStore.getState().openDraftEditor({ assetId, projectId: null });
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "layer_fonts") return ["Arial", "PingFang SC"];
    if (command === "layer_export_font_names") return { Arial: "ArialMT" };
    if (command === "plugin:dialog|save") return w.cancelExport ? null : "/synthetic/draft.psd";
    if (command === "layer_export_psd") { w.exports.push(args); return ""; }
    if (command === "draft_workspace_load") return JSON.parse(sessionStorage.getItem("draft-fixture") || "null");
    if (command === "draft_workspace_save") {
      if (w.delaySave) await new Promise(resolve => { w.releaseSave = resolve; });
      if (w.failSave) throw "模拟磁盘保存失败";
      const old = w.saves.find((save: any) => save.saveId === args.saveId);
      if (!old) w.saves.push(structuredClone(args));
      sessionStorage.setItem("draft-fixture", JSON.stringify(args.document));
      return { id: args.saveId, name: "草稿", ext: "png", store_path: args.dataUrl, width: args.document.width, height: args.document.height, source: "draft" };
    }
    throw new Error(`Unexpected isolated draft IPC: ${command}`);
  },
};
createRoot(document.getElementById("root")!).render(<React.StrictMode><button onClick={() => w.openDraft()}>新建草稿</button><DraftEditor /></React.StrictMode>);
