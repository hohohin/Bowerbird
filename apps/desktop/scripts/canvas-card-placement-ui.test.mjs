import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ configFile: false, root: process.cwd(),
  plugins: [{ name: "placement-hidden-tools", transform(code, id) {
    if (id.endsWith("/src/lib/featureFlags.ts")) return code.replace(/(WORKFLOW_(?:SKILL|PLANNER)_ENABLED = )false/g, "$1true");
  } }], server: { host: "127.0.0.1", port: 1638, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
const tools = [
  ["text", "内容卡片工具"], ["bubble", "气泡便签工具"], ["instruction", "新增指令卡片"],
  ["loop", "新增循环卡片"], ["generation", "新增生成卡片"], ["skill", "新增技能卡片"],
  ["planner", "新增工作流助手"], ["agent", "新增 Agent 卡片"], ["visual-profile", "新增视觉规范卡片"],
];
const snapshot = () => page.evaluate(async () => {
  const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
  return [...window.snapshot().nodes, ...canvasWorkflowController("p").document.nodes];
});
async function target(x, y) {
  return page.locator("[data-canvas-stage]").evaluate((stage, { x, y }) => {
    const rect = stage.getBoundingClientRect();
    const transform = getComputedStyle(stage.querySelector(".canvas-plane")).transform;
    const matrix = new DOMMatrix(transform);
    return { clientX: rect.left + x, clientY: rect.top + y, x: (x - matrix.e) / matrix.a, y: (y - matrix.f) / matrix.d, transform };
  }, { x, y });
}
async function placed(before, point) {
  await page.waitForFunction(async count => {
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    return window.snapshot().nodes.length + canvasWorkflowController("p").document.nodes.length > count;
  }, before.length);
  const after = await snapshot();
  assert.equal(after.length, before.length + 1, "one gesture creates exactly one card");
  const node = after.find(node => !before.some(old => old.id === node.id));
  assert.ok(Math.abs(node.x - point.x) < 1 && Math.abs(node.y - point.y) < 1, "card stays at the requested canvas coordinate");
  assert.equal(await page.locator(".canvas-plane").evaluate(el => getComputedStyle(el).transform), point.transform, "placement does not move or zoom the canvas");
  assert.equal(await page.getByRole("button", { name: "选择工具", exact: true }).getAttribute("aria-pressed"), "true");
}
try {
  await page.goto("http://127.0.0.1:1638/scripts/fixtures/canvas-reference/preview.html?provisional&strict-canvas");
  await page.waitForFunction(async () => {
    const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
    return canvasWorkflowController("p").ready && document.querySelector('.canvas-workspace[aria-busy="false"]');
  });
  const groups = await page.getByRole("toolbar", { name: "画板工具" }).evaluate(el => {
    const groups = [[]];
    for (const child of el.children) {
      if (child.tagName === "HR") groups.push([]);
      else if (child.tagName === "BUTTON") groups.at(-1).push(child.getAttribute("aria-label"));
    }
    return groups;
  });
  assert.deepEqual(groups[0], ["选择工具", "抓手工具", "分区工具"]);
  assert.deepEqual(groups[1], [...tools.map(([, label]) => label), "发条触发器"]);

  for (const [kind, label] of tools) {
    const button = page.getByRole("button", { name: label, exact: true });
    const before = await snapshot();
    await button.click();
    await button.click();
    assert.deepEqual(await snapshot(), before, `${kind}: clicking only selects the tool`);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    if (kind === "text") assert.equal(await page.evaluate(() => window.calls.some(call => call.command === "project_canvas_materialize")), false);
    await page.keyboard.press("Escape");
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    await button.focus(); await page.keyboard.press("Enter");
    const point = await target(400, 220);
    await page.mouse.click(point.clientX, point.clientY);
    await placed(before, point);

    const beforeDrag = await snapshot();
    const drop = await target(500, 340);
    await button.dragTo(page.locator("[data-canvas-stage]"), { targetPosition: { x: 500, y: 340 } });
    await placed(beforeDrag, drop);
  }
  // Cancel a real drag outside the canvas, then switch tools without creating.
  const beforeCancel = await snapshot();
  await page.getByRole("button", { name: "内容卡片工具", exact: true }).dragTo(page.locator(".canvas-source-header"));
  assert.deepEqual(await snapshot(), beforeCancel);
  await page.getByRole("button", { name: "新增指令卡片", exact: true }).click();
  await page.getByRole("button", { name: "抓手工具", exact: true }).click();
  const blank = await target(800, 700);
  await page.mouse.click(blank.clientX, blank.clientY);
  assert.deepEqual(await snapshot(), beforeCancel);

  // A pending winding key must not attach when another card tool takes over.
  await page.getByRole("button", { name: "发条触发器", exact: true }).click();
  assert.deepEqual(await snapshot(), beforeCancel);
  await page.getByRole("button", { name: "气泡便签工具", exact: true }).click();
  const bubblePoint = await target(800, 500);
  await page.mouse.click(bubblePoint.clientX, bubblePoint.clientY);
  await placed(beforeCancel, bubblePoint);
  assert.equal((await snapshot()).some(node => node.trigger), false);

  await page.getByRole("button", { name: "缩小", exact: true }).click();
  await page.getByRole("button", { name: "抓手工具", exact: true }).click();
  await page.mouse.move(blank.clientX, blank.clientY); await page.mouse.down();
  await page.mouse.move(blank.clientX - 70, blank.clientY - 40, { steps: 6 }); await page.mouse.up();
  const scaledBefore = await snapshot(), scaledPoint = await target(700, 600);
  await page.getByRole("button", { name: "新增生成卡片", exact: true }).click();
  await page.mouse.click(scaledPoint.clientX, scaledPoint.clientY);
  await placed(scaledBefore, scaledPoint);
  const triggerTool = page.getByRole("button", { name: "发条触发器", exact: true });
  const triggerBefore = await snapshot(), triggerPoint = await target(150, 800);
  await triggerTool.click();
  assert.deepEqual(await snapshot(), triggerBefore);
  await page.mouse.click(triggerPoint.clientX, triggerPoint.clientY);
  await placed(triggerBefore, triggerPoint);
  const triggerDragBefore = await snapshot(), triggerDrop = await target(150, 1000);
  const toolBox = await triggerTool.boundingBox();
  await page.mouse.move(toolBox.x + toolBox.width / 2, toolBox.y + toolBox.height / 2); await page.mouse.down();
  await page.mouse.move(triggerDrop.clientX, triggerDrop.clientY, { steps: 12 }); await page.mouse.up();
  await placed(triggerDragBefore, triggerDrop);
  assert.deepEqual(errors, []);
  console.log("PASS: tool groups; all nine card tools select without creating, keyboard/Escape, click and real drag placement, exact overlapping coordinates, no viewport shift, canceled drag, tool switching, winding-key cancellation, pan/zoom.");
} finally { await browser.close(); await server.close(); }
