import { flushSync } from "react-dom";

const w = window as any;
const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="190" height="150"><rect width="190" height="150" fill="#387ca4"/></svg>')}`;
const assets = Array.from({ length: 100 }, (_, index) => ({ id: `interaction-asset-${index}`, name: `素材 ${index}`, width: 190, height: 150, store_path: picture, source: "imported" }));
const base = { projectId: "p", threadId: "t", hiddenAt: null, positionLocked: false, createdAt: 1, updatedAt: 1, zIndex: 1, role: "reference", kind: "asset", width: 190, height: 182 };
const nodes = assets.flatMap((asset, index) => {
  const x = index < 2 ? 240 : 20000 + (index % 10) * 1400;
  const y = index < 2 ? 170 + index * 440 : 20000 + Math.floor(index / 10) * 650;
  return [{ ...base, id: `material-${index}`, assetId: asset.id, x, y, payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: 190, height: 150 } }) },
    { ...base, id: `content-${index}`, kind: "note", role: null, assetId: null, x: x + 280, y, width: 320, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: "text", text: `内容 ${index}`, cells: [[{ id: `cell-${index}`, text: `内容 ${index}`, bold: false, italic: false, align: "left" }]], member_ids: [] }) }];
});
const workflow = assets.map((asset, index) => {
  const material = nodes[index * 2];
  return { id: `workflow-${index}`, kind: "instruction", x: material.x + 760, y: material.y, action: "reuse", skill: "image-edit", prompt: "", ratio: null,
    provider: "codex", inputs: { image: [{ assetId: asset.id, assetNodeId: material.id }], text: [{ canvasNodeId: `content-${index}`, cellId: `cell-${index}` }] },
    outputs: {}, outputPorts: [], trigger: false };
});
sessionStorage.setItem("reference-drafts", JSON.stringify(assets));
sessionStorage.setItem("reference-fixture", JSON.stringify({ canvas: { projectId: "p", draftJson: "{}", createdAt: 1, updatedAt: 1 }, nodes,
  edges: [], groups: [], groupItems: [], threads: [{ id: "t", projectId: "p", title: "交互性能", archivedAt: null }], executionLinks: [],
  view: { projectId: "p", panX: 0, panY: 0, zoom: 1, sourcePanelWidth: 300, viewMode: "canvas", timelineScope: "all" } }));
sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: workflow, run: null } }));
localStorage.setItem("bowerbird.canvasSnapEnabled", "false");
w.interactionStats = null;
w.resetInteractionStats = () => { w.interactionStats = { workspaceRenders: 0, workspaceCommits: 0, workflowRenders: 0, workflowCommits: 0, globalNodeQueries: 0, portQueries: 0, rectReads: 0, portRectReads: 0, stageRectReads: 0 }; };
for (const prototype of [Document.prototype, Element.prototype]) {
  const query = prototype.querySelectorAll;
  prototype.querySelectorAll = function(selector: string) {
    if (w.interactionStats) {
      if (this instanceof Document && selector.includes("data-canvas-node-id")) w.interactionStats.globalNodeQueries += 1;
      if (selector.includes("data-workflow-cell") || selector.includes("data-workflow-text-input")) w.interactionStats.portQueries += 1;
    }
    return query.call(this, selector);
  } as typeof query;
}
const rect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function() {
  if (w.interactionStats) {
    w.interactionStats.rectReads += 1;
    if (this.matches("[data-workflow-cell],[data-workflow-text-input],[data-canvas-cell]")) w.interactionStats.portRectReads += 1;
    if (this.classList.contains("canvas-stage")) w.interactionStats.stageRectReads += 1;
  }
  return rect.call(this);
};
w.interactionFlush = flushSync;
await import("../canvas-reference/preview");
w.store.setState({ canvasLibraryOpen: false });
export {};
