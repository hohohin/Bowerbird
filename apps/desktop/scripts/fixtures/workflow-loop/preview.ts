import { newWorkflowNode } from "../../../src/lib/canvasWorkflow";

// Seed the isolated canvas fixture once. Reloads exercise its saved workflow and results.
if (!sessionStorage.getItem("workflow-p")) {
  const lines = ["清晨，窗边的咖啡杯", "手部特写，倒入燕麦奶", "俯拍，杯面泛起涟漪", "拉远，人物端杯离开"];
  const note = (id: string, title: string, x: number, texts: string[]) => ({
    id, projectId: "p", kind: "note", threadId: null, assetId: null, role: null, hiddenAt: null,
    positionLocked: false, x, y: 140, width: 268, height: 230, zIndex: 1, createdAt: 1, updatedAt: 1,
    payloadJson: JSON.stringify({ schema_version: 1, note_type: "text", title, text: texts.join("\n"), member_ids: [],
      cells: texts.map((text, i) => [{ id: `${id}-${i}`, text, bold: false, italic: false, align: "left" }]) }),
  });
  const loop = { ...newWorkflowNode("loop", 350, 140, ""), id: "shot-loop", loopMode: "rows",
    inputs: { text: [{ canvasNodeId: "shots", cellId: "*text" }] } };
  const writer = { ...newWorkflowNode("text", 746, 140, ""), id: "shot-writer",
    inputs: { text: [{ nodeId: loop.id, portId: "text" }] }, textTarget: { nodeId: "result", cellId: "result-0", append: true } };
  sessionStorage.setItem("reference-fixture", JSON.stringify({
    canvas: { projectId: "p", draftJson: "{}", createdAt: 1, updatedAt: 1 }, nodes: [note("shots", "分镜清单", 0, lines), note("result", "本次选用", 746, [""])],
    edges: [], groups: [], groupItems: [], threads: [], executionLinks: [],
    view: { projectId: "p", panX: 80, panY: 15, zoom: 1, sourcePanelWidth: 260, viewMode: "canvas", timelineScope: "all" },
  }));
  sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: {
    schema_version: 1, nodes: [loop, writer], cardNames: { "shot-loop": "逐条整理分镜", shots: "分镜清单", result: "本次选用" }, run: null,
  } }));
}
await import("../canvas-reference/preview");
window.addEventListener("pagehide", () => (window as Window & { save(): void }).save());

// Give the viewer time to inspect and stop each item in this otherwise instant local copy.
const { api } = await import("../../../src/lib/api");
const { canvasWorkflowController } = await import("../../../src/lib/canvasWorkflowRuntime");
const getCanvas = api.projectCanvasGet;
let currentItem = "", readReady: Promise<void>;
api.projectCanvasGet = async projectId => {
  const run = canvasWorkflowController(projectId).document.run;
  if (run?.status === "running" && run.loop?.nodeId === "shot-loop") {
    const item = `${run.id}:${run.loop.index}`;
    if (item !== currentItem) {
      currentItem = item;
      readReady = new Promise(resolve => setTimeout(resolve, 1500));
    }
    await readReady;
  }
  return getCanvas(projectId);
};
