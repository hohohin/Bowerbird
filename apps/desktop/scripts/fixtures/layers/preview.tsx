import React from "react";
import { createRoot } from "react-dom/client";
import { LayerEditor } from "../../../src/components/LayerEditor";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
const png = (width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) => {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  paint(canvas.getContext("2d")!); return canvas.toDataURL("image/png");
};
const background = png(1024, 768, ctx => { ctx.fillStyle = "#eee9dc"; ctx.fillRect(0, 0, 1024, 768); ctx.fillStyle = "#b9caaa"; ctx.fillRect(0, 590, 1024, 178); });
const circle = png(400, 400, ctx => { ctx.fillStyle = "#d2744b"; ctx.beginPath(); ctx.arc(200, 200, 180, 0, Math.PI * 2); ctx.fill(); });
const title = png(700, 100, ctx => { ctx.fillStyle = "#263731"; ctx.font = "bold 72px sans-serif"; ctx.fillText("BOWERBIRD", 10, 80); });
const layer = { opacity: 1, visible: true, description: "", background: false };
const documentValue = { schemaVersion: 1, width: 1024, height: 768, layers: [
  { ...layer, id: "base", name: "底图", dataUrl: background, x: 0, y: 0, width: 1024, height: 768, background: true },
  { ...layer, id: "circle", name: "圆形装饰", dataUrl: circle, x: 380, y: 200, width: 400, height: 400 },
  { ...layer, id: "title", name: "标题文字", description: "保留透明通道的独立标题", dataUrl: title, x: 140, y: 85, width: 700, height: 100 },
] };
const source = { id: "source", name: "设计探索", ext: "png", store_path: background, width: 1024, height: 768, source: "imported" };
w.store = useStore; w.calls = []; w.exports = []; w.failSave = false; w.pendingBusy = false; w.enabled = true;
let job: any = JSON.parse(sessionStorage.getItem("layer-job") || "null");
let saved = JSON.parse(sessionStorage.getItem("layer-workspace") || "null");
w.documentFixture = documentValue;
w.saved = () => structuredClone(saved);
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "get_assets_by_ids") return [source];
    if (command === "read_image_data_url") return background;
    if (command === "layer_workspace_load") return saved;
    if (command === "layer_workspace_save") {
      if (w.failSave) throw "模拟磁盘保存失败";
      saved = structuredClone(args.workspace); sessionStorage.setItem("layer-workspace", JSON.stringify(saved)); return;
    }
    if (command === "layer_export") { w.exports.push(args); return { ...source, id: "exported" }; }
    if (command === "layer_cloud_request") {
      const request = args.request;
      if (request.action === "layer_quote") return { status: "quoted", services: ["image_layer_decompose", "image_layer_edit"].map(service => ({ service, available: w.enabled, credits: w.enabled ? 20 : null })) };
      if (request.action === "get_by_key") {
        if (!job || job.idempotency_key !== request.idempotency_key) return { status: "not_found" };
        if (w.pendingBusy) return { status: "running", progress: 40 };
        return { status: "succeeded", layer_result: job.layer_options.operation === "edit" ? { image: circle } : { document: documentValue } };
      }
      job = request; sessionStorage.setItem("layer-job", JSON.stringify(job));
      if (w.submitDisconnect) { w.submitDisconnect = false; throw "模拟提交响应丢失"; }
      return { status: "queued", progress: 0 };
    }
    if (command === "cloud_entitlement") return null;
    if (command === "list_analyses_by_asset") return [];
    throw new Error(`Unexpected synthetic IPC: ${command}`);
  },
};
useStore.setState({ assets: [source], activeProjectId: "project-original", cloudAuth: { logged_in: true, cloud_available: true, user_id: "user-original" } as any });
const open = () => useStore.getState().openLayerEditor("source");
createRoot(document.getElementById("root")!).render(<><button onClick={open}>打开分层编辑</button><button onClick={() => useStore.setState({ contextMenu: { assetId: "source", x: 120, y: 80, asset: source } as any })}>打开右键菜单</button><LayerEditor /><AssetContextMenu /></>);
