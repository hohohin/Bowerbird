import "../../../src/components/IndustrialTheme.css";
document.documentElement.dataset.theme = "dark";
// Reuse the closed real-CanvasWorkspace harness; no application database or native filesystem.
const w = window as any;
const sample = new URLSearchParams(location.search).get("case") ?? "plain";
const base = { projectId: "p", threadId: "t", hiddenAt: null, positionLocked: false, createdAt: 1, updatedAt: 1,
  width: 190, height: 180, zIndex: 1, role: "reference", kind: "asset", assetId: "existing" };
const asset = (id: string, assetId: string, x: number, y = 100) => ({ ...base, id, assetId, x, y,
  payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 190, height: 150 } }) });
const plain = [asset("first", "existing", 100), asset("second", "a", 410)];
const prompt = { ...base, id: "session", kind: "prompt", assetId: null, role: null, x: 120, y: 100, width: 260, height: 148,
  payloadJson: JSON.stringify({ schema_version: 1, job_id: "job", turn_key: "one", text: "合成会话", provider: "codex", status: "done" }) };
const outputs = ["a", "b"].map((id, index) => ({ ...asset(`output-${id}`, id, 500 + index * 220), role: "output",
  payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: id, width: 190, height: 150 }, execution: { job_id: "job", turn_key: "one" } }) }));
const members = [asset("member-a", "a", 100), asset("member-b", "b", 100)];
sessionStorage.setItem("reference-fixture", JSON.stringify({
  canvas: { projectId: "p", draftJson: "{}", createdAt: 1, updatedAt: 1 },
  nodes: sample === "group" ? members : sample === "conversation" ? [prompt, ...outputs, asset("first", "existing", 740)] : plain,
  edges: sample === "conversation" ? outputs.map((node, ordinal) => ({ id: `edge-${ordinal}`, projectId: "p", threadId: "t", fromNodeId: "session", toNodeId: node.id, kind: "produced", ordinal, createdAt: 1 })) : [],
  groups: sample === "group" ? [{ id: "group", projectId: "p", name: "素材组", role: null, x: 100, y: 100, width: 240, height: 230, zIndex: 2, createdAt: 1, updatedAt: 1 }] : [],
  groupItems: sample === "group" ? members.map((node, ordinal) => ({ groupId: "group", nodeId: node.id, ordinal })) : [],
  threads: [{ id: "t", projectId: "p", title: "合成线程", archivedAt: null }], executionLinks: [],
  view: { projectId: "p", panX: 0, panY: 0, zoom: 1, sourcePanelWidth: 300, viewMode: "canvas", timelineScope: "all" },
}));
await import("../canvas-reference/preview");
w.isTauri = true; w.exportCalls = []; w.cancellations = []; w.picks = []; w.peeks = [];
window.addEventListener("bowerbird://board-asset-picked", (event: any) => w.picks.push(event.detail));
window.addEventListener("bowerbird://board-asset-peek", (event: any) => w.peeks.push(event.detail.assetId));
const original = w.__TAURI_INTERNALS__.invoke;
w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
  if (command === "start_external_drag") {
    w.exportCalls.push(args);
    return new Promise((resolve, reject) => { w.finishExport = resolve; w.failExport = reject; });
  }
  if (command === "cancel_pending_external_drag") { w.cancellations.push(args); return Promise.resolve(true); }
  if (command === "generation_history") return Promise.resolve({ turns: [], references: [] });
  return original(command, args);
};
w.changeProject = () => w.store.setState({ activeProjectId: "q", projectRouteRevision: w.store.getState().projectRouteRevision + 1 });
export {};
