// A closed, synthetic-media fixture around the real CanvasWorkspace fixture.
const w = window as any;
const scenario = new URLSearchParams(location.search).get("scenario") || "images";
const count = scenario === "tiers" ? 1 : 330;
const base = { projectId: "p", threadId: "t", hiddenAt: null, positionLocked: false,
  createdAt: 1, updatedAt: 1, width: 190, height: 127, zIndex: 1,
  role: "reference", kind: "asset" };
const assets = Array.from({ length: count }, (_, index) => {
  const video = scenario === "videos" || (scenario === "mixed" && index % 2 === 1);
  return { id: `perf-${index}`, name: `媒体 ${index}`, width: 4096, height: 2048,
    store_path: `/__canvas_perf__/original/${index}.${video ? "mp4" : "png"}`,
    thumb_path: null, source: "imported", ext: video ? "mp4" : "png" };
});
const nodes = assets.map((asset, index) => ({ ...base, id: `perf-node-${index}`, assetId: asset.id,
  x: index < 30 ? 240 + (index % 6) * 220 : 20000 + (index % 20) * 240,
  y: index < 30 ? 130 + Math.floor(index / 6) * 160 : 20000 + Math.floor(index / 20) * 180,
  ...(scenario === "tiers" ? { width: 800, height: 432, x: 300, y: 200 } : {}),
  payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height } }),
}));
sessionStorage.setItem("reference-drafts", JSON.stringify(assets));
sessionStorage.setItem("reference-fixture", JSON.stringify({
  canvas: { projectId: "p", draftJson: "{}", createdAt: 1, updatedAt: 1 }, nodes,
  edges: nodes.slice(1, 10).map((node, index) => ({ id: `perf-edge-${index}`, projectId: "p", threadId: "t",
    fromNodeId: nodes[index].id, toNodeId: node.id, kind: "input", ordinal: index, createdAt: 1 })),
  groups: [], groupItems: [], threads: [{ id: "t", projectId: "p", title: "媒体性能", archivedAt: null }], executionLinks: [],
  view: { projectId: "p", panX: 0, panY: 0, zoom: scenario === "tiers" ? 0.5 : 1, sourcePanelWidth: 300,
    viewMode: "canvas", timelineScope: "all" },
}));
w.mediaCalls = [];
let internals: any;
Object.defineProperty(w, "__TAURI_INTERNALS__", {
  configurable: true,
  get: () => internals,
  set(value) {
    const invoke = value.invoke;
    value.invoke = async (command: string, args: any) => {
      if (command === "canvas_image_preview") {
        w.mediaCalls.push({ command, args });
        const id = args.path.match(/\/(\d+)\.png$/)?.[1] || "0";
        return `/__canvas_perf__/preview/${args.maxSize}/${id}.png`;
      }
      if (command === "video_poster") {
        w.mediaCalls.push({ command, args });
        const id = args.sourcePath.match(/\/(\d+)\.mp4$/)?.[1] || "0";
        return `/__canvas_perf__/poster/512/${id}.png`;
      }
      return invoke(command, args);
    };
    internals = value;
  },
});
await import("../canvas-reference/preview");
w.store.setState({ canvasLibraryOpen: false });
export {};
