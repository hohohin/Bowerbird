import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "../../html-renderer/node_modules/playwright/index.mjs");
const host = "127.0.0.1";
const server = await createServer({ server: { host, port: 17997, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;

try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const card = id => page.locator(`[data-canvas-node-id="${id}"], [data-workflow-card="${id}"]:not([data-workflow-peek])`);
  const menuItem = name => page.getByRole("menuitem", { name, exact: true });
  const undo = page.getByRole("button", { name: "撤销画布操作", exact: true });
  const redo = page.getByRole("button", { name: "重做画布操作", exact: true });
  const reset = page.getByRole("button", { name: "重置缩放到 100%", exact: true });
  const start = { old: [70, 110], content: [445, 380], flow: [1010, 690], locked: [290, 935] };

  async function openAlignmentMenu() {
    await card("old").click({ button: "right", position: { x: 35, y: 40 } });
    await menuItem("对齐与分布").click();
  }

  async function assertPositions(expected) {
    await page.waitForFunction(expected => {
      const plane = document.querySelector(".canvas-plane");
      const origin = plane.getBoundingClientRect();
      const zoom = new DOMMatrixReadOnly(getComputedStyle(plane).transform).a;
      const saved = [...window.snapshot().nodes, ...JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes];
      return Object.entries(expected).every(([id, [x, y]]) => {
        const persisted = saved.find(node => node.id === id);
        const card = document.querySelector(`[data-canvas-node-id="${id}"], [data-workflow-card="${id}"]:not([data-workflow-peek])`);
        if (!card || persisted?.x !== x || persisted.y !== y) return false;
        const rect = card.getBoundingClientRect();
        return Math.abs((rect.left - origin.left) / zoom - x) < 0.1 && Math.abs((rect.top - origin.top) / zoom - y) < 0.1;
      });
    }, expected);
  }

  async function assertZoom(expected) {
    await page.waitForFunction(zoom => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".canvas-plane")).transform);
      return Math.abs(matrix.a - zoom) < 0.00001 && Math.abs(window.snapshot().view.zoom - zoom) < 0.00001;
    }, expected).catch(async error => {
      assert.fail(`Expected zoom ${expected}, rendered ${(await camera()).zoom}, saved ${await page.evaluate(() => window.snapshot().view.zoom)}\n${error.message}`);
    });
    assert.equal(await reset.innerText(), `${Math.round(expected * 100)}%`);
  }

  const camera = () => page.locator(".canvas-plane").evaluate(plane => {
    const { a: zoom, e: x, f: y } = new DOMMatrixReadOnly(getComputedStyle(plane).transform);
    return { x, y, zoom };
  });

  await page.goto(`http://${host}:${server.config.server.port}/scripts/fixtures/canvas-reference/preview.html`);
  await card("old").waitFor();
  await page.evaluate(async positions => {
    const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
    const snapshot = window.snapshot();
    const [base, far] = snapshot.nodes;
    const at = id => ({ id, x: positions[id][0], y: positions[id][1] });
    const note = id => ({ ...base, ...at(id), kind: "note", assetId: null, role: null, width: 320, height: 185,
      positionLocked: id === "locked", payloadJson: JSON.stringify({ schema_version: 1, note_type: "bubble", text: id }) });
    snapshot.nodes = [{ ...base, ...at("old") }, note("content"), note("locked"),
      { ...far, x: 4200, payloadJson: JSON.stringify({ schema_version: 1, note_type: "bubble", text: "远处便签" }) }];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    const flow = { ...newWorkflowNode("trigger", ...positions.flow, "jimeng"), id: "flow" };
    sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 1, document: { schema_version: 1, nodes: [flow], run: null } }));
  }, start);
  await page.reload();
  await card("flow").waitFor();
  await assertPositions(start);

  const toggle = async id => card(id).click({ modifiers: ["Control"], position: { x: 35, y: id === "old" ? 40 : 15 } });
  await toggle("old");
  await toggle("content");
  await openAlignmentMenu();
  assert.equal(await menuItem("水平等距分布").isDisabled(), true);
  assert.equal(await menuItem("垂直等距分布").isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await toggle("flow");
  await toggle("locked");
  for (const id of Object.keys(start)) assert.match(await card(id).getAttribute("class"), /\bis-selected\b/);

  const aligned = { ...start, content: [70, 380], flow: [70, 690] };
  await openAlignmentMenu();
  await menuItem("左对齐").click();
  await assertPositions(aligned);
  await undo.click();
  await assertPositions(start);
  await redo.click();
  await assertPositions(aligned);
  await undo.click();
  await assertPositions(start);

  const firstWidth = await card("old").evaluate(element => element.offsetWidth);
  const middleWidth = await card("content").evaluate(element => element.offsetWidth);
  const middleX = Math.round((start.old[0] + start.flow[0] + firstWidth - middleWidth) / 2);
  const distributed = { ...start, content: [middleX, start.content[1]] };
  await openAlignmentMenu();
  await menuItem("水平等距分布").click();
  await assertPositions(distributed);
  await undo.click();
  await assertPositions(start);
  await redo.click();
  await assertPositions(distributed);

  await page.evaluate(() => window.save());
  await page.reload();
  await card("flow").waitFor();
  await assertPositions(distributed);
  await page.keyboard.press("Shift+Digit2");
  assert.deepEqual(await camera(), { x: 0, y: 0, zoom: 1 });
  await toggle("old");
  await toggle("content");
  await toggle("flow");

  const stage = await page.locator(".canvas-stage").boundingBox();
  const far = await page.evaluate(() => window.snapshot().nodes.find(node => node.id === "far"));
  const fitAll = (stage.width - 120) / (far.x + far.width - start.old[0]);
  await page.keyboard.press("Shift+Digit1");
  await assertZoom(fitAll);
  await page.keyboard.press("Shift+Digit2");
  await assertZoom(1);
  assert.notEqual((await camera()).x, 0, "fit selection centers its bounds");
  await page.keyboard.press("Shift+Digit1");
  await assertZoom(fitAll);
  const before = await camera();
  await page.keyboard.press("Shift+Digit0");
  await assertZoom(1);
  const after = await camera();
  assert.ok(Math.abs(after.x - (stage.width / 2 - (stage.width / 2 - before.x) / before.zoom)) < 0.01);
  assert.ok(Math.abs(after.y - (stage.height / 2 - (stage.height / 2 - before.y) / before.zoom)) < 0.01);

  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await assertZoom(0.85);
  const input = page.locator('[data-card-name="content"] input');
  await input.focus();
  assert.equal(await input.evaluate(element => document.activeElement === element), true);
  const whileEditing = await camera();
  await page.keyboard.press("Shift+Digit0");
  await page.keyboard.press("Shift+Digit1");
  assert.deepEqual(await camera(), whileEditing);
  await reset.click();
  await assertZoom(1);
  assert.deepEqual(errors, []);
  console.log("PASS canvas alignment/distribution menu, locks, Undo/Redo, persistence, fit shortcuts, centered reset and input focus");
} finally {
  await browser?.close();
  await server.close();
}
