import React from "react";
import { createRoot } from "react-dom/client";
import { DraftEditor } from "../../../src/components/DraftEditor";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.saves = [];
w.openDraft = (assetId: string | null = null) => useStore.getState().openDraftEditor({ assetId, projectId: null });
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    if (command === "layer_fonts") return ["Arial"];
    if (command === "draft_workspace_load") return w.savedDocument;
    if (command === "draft_workspace_save") {
      w.saves.push(structuredClone(args)); w.savedDocument = structuredClone(args.document);
      return { id: "synthetic-draft", name: "合成草稿", ext: "png", store_path: args.dataUrl,
        width: args.document.width, height: args.document.height, source: "draft" };
    }
    throw new Error(`Unexpected isolated StrictMode IPC: ${command}`);
  },
};
const content = <><button onClick={() => w.openDraft()}>新建草稿</button><DraftEditor /></>;
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).get("strict") === "0" ? content : <React.StrictMode>{content}</React.StrictMode>);
