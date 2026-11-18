import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 17989, watch: null, hmr: false } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.setDefaultTimeout(7000);
  await page.goto(server.resolvedUrls.local[0] + "scripts/fixtures/canvas-auto-connect/preview.html");
  const source = page.locator('[data-canvas-node-id="old"]');
  await source.waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const target = { ...newWorkflowNode("generation", 890, 380, "codex"), id: "receiver" };
    sessionStorage.setItem("workflow-p", JSON.stringify({revision: 0, document: {schema_version: 1, nodes: [target], run: null}}));
  });
  await page.reload();
  const target = page.locator('[data-workflow-card="receiver"]');
  await target.waitFor();
  await page.evaluate(async () => {
    const { useStore } = await import("/src/store.ts");
    useStore.setState({ boardOpen: false, genEditing: null, captionedIds: new Set(["existing"]), promptedAssets: [{id: "existing", sections: [{title:"构图",body:"中心构图"}]}] });
  });
  await source.getByRole("button", {name:"打开维度环",exact:true}).click();
  const label = page.locator('.caption-ring-sector-label');
  await label.waitFor();
  await page.mouse.move(1400, 950);
  await page.waitForTimeout(350);
  const a = await label.boundingBox(), b = await target.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
  await page.mouse.down();
  await page.mouse.move(b.x+50,b.y+25,{steps:20});
  await page.mouse.up();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].inputs.text?.length);
  const inputs = await page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].inputs);
  assert.equal(inputs.text[0].dimension.body,"中心构图");
  assert.equal(inputs.image[0].assetId,"existing");
  assert.equal(inputs.text[0].autoConnect,inputs.image[0].autoConnect);
  const both = await page.evaluate(() => sessionStorage.getItem("workflow-p"));
  const removeImage = target.locator('[data-workflow-reference-remove="existing"]');
  await removeImage.locator("..").hover();
  await removeImage.click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].inputs.image.length);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].inputs.text[0].dimension.body), "中心构图");
  await page.evaluate(snapshot => sessionStorage.setItem("workflow-p", snapshot), both);
  await page.reload();
  await target.hover();
  await target.locator('[data-canvas-connect-side="input"]:not(.canvas-cell-connection)').click({button:"right"});
  await page.getByRole("menuitem", {name:/维度文本.*构图/}).click();
  await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].inputs.text.length);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].inputs.image[0].assetId), "existing");
  await removeImage.waitFor({state:"attached"});
  console.log("PASS click badge, dimension drag, thumbnail and input menu detach separately");
} finally { await browser.close(); await server.close(); }
