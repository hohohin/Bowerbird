import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1577, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
async function verifyAlpha(image) {
  await image.waitFor();
  const actual = await image.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 150;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return { src: image.src, background: getComputedStyle(image).backgroundColor,
      parentBackground: getComputedStyle(image.parentElement).backgroundColor,
      alpha: [10, 65, 110].map(x => ctx.getImageData(x, 75, 1, 1).data[3]) };
  });
  assert.match(actual.src, /^data:image\/(png|webp)/);
  assert.deepEqual(actual.alpha, [0, 128, 255], "fully transparent and partial alpha survive legacy JPEG thumbnails");
  assert.equal(actual.background, "rgba(0, 0, 0, 0)");
  assert.equal(actual.parentBackground, "rgba(0, 0, 0, 0)");
}
try {
  await page.goto("http://127.0.0.1:1577/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(async () => {
    const {newWorkflowNode}=await import('/src/lib/canvasWorkflow.ts');
    sessionStorage.setItem('workflow-p',JSON.stringify({revision:0,document:{schema_version:1,run:null,nodes:[{
      ...newWorkflowNode('instruction',800,400,'codex'),id:'alpha-preview',action:'describe',inputs:{image:[{assetId:'alpha'}]},
    }]}}));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 150;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(0, 150, 255, .5)";
    ctx.fillRect(50, 25, 50, 100);
    ctx.fillStyle = "#0096ff";
    ctx.fillRect(100, 25, 50, 100);
    const original = canvas.toDataURL("image/png");
    const webp = canvas.toDataURL("image/webp", 1);
    // Simulate already-imported assets with opaque, black-backed JPEG thumbnails.
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, 150, 150);
    const thumb = canvas.toDataURL("image/jpeg");
    sessionStorage.setItem("reference-drafts", JSON.stringify([
      { id: "alpha", name: "透明 PNG", width: 150, height: 150, store_path: original, thumb_path: thumb, source: "annotation" },
      { id: "webp", name: "透明 WebP", width: 150, height: 150, store_path: webp, thumb_path: thumb, source: "annotation" },
      { id: "jpeg", name: "普通 JPEG", width: 150, height: 150, store_path: thumb, thumb_path: thumb, source: "annotation" },
    ]));
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = ["alpha", "webp", "jpeg", "alpha"].map((assetId, index) => ({ ...base,
      id: `image-${index}`, assetId, x: 80 + index * 230, y: 100, width: 190,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: assetId, width: 150, height: 150 } }),
    }));
    snapshot.groups = [{ id: "folder", projectId: "p", name: "素材组", role: null, x: 80, y: 400,
      width: 240, height: 230, zIndex: 2, createdAt: 1, updatedAt: 1 }];
    snapshot.groupItems = [{ groupId: "folder", nodeId: "image-3", ordinal: 0 }];
    snapshot.edges = [];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });
  await page.reload();
  const workflowImage=page.locator('[data-workflow-card="alpha-preview"] .workflow-preview img');
  await workflowImage.waitFor();
  const workflowPixels=await workflowImage.evaluate(async image=>{
    await image.decode();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=150;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return [10,65,110].map(x=>Array.from(ctx.getImageData(x,75,1,1).data));
  });
  assert.deepEqual(workflowPixels.map(pixel=>pixel[3]),[0,128,255],'workflow preview retains alpha despite black JPEG thumbnail');
  assert.deepEqual(workflowPixels[2],[0,150,255,255],'opaque foreground retains its original colour');
  for (const id of ["image-0", "image-1"]) await verifyAlpha(node(id).locator(":scope > img"));
  assert.match(await node("image-2").locator(":scope > img").getAttribute("src"), /^data:image\/jpeg/);
  await verifyAlpha(node("folder").locator(".canvas-folder-grid img"));
  await node("folder").click();
  await verifyAlpha(node("folder").locator(".canvas-folder-asset img"));
  await mkdir(".tmp/canvas-transparency", { recursive: true });
  await page.screenshot({ path: ".tmp/canvas-transparency/transparent-canvas.png" });
  await page.evaluate(() => window.save());
  await page.reload();
  await verifyAlpha(node("image-0").locator(":scope > img"));
  await verifyAlpha(node("folder").locator(".canvas-folder-grid img"));
  assert.deepEqual(errors, []);
  console.log("PASS existing PNG/WebP alpha, transparent card backgrounds, JPEG fallback, collapsed/expanded folders and reload.");
} finally { await browser.close(); await server.close(); }
