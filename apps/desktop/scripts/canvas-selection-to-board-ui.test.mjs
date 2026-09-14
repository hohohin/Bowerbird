import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1456, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const editor = page.locator(".ProseMirror");
const chips = () => editor.locator("[data-asset-id]").evaluateAll(elements => elements.map(e => e.dataset.assetId));

async function reset() {
  await page.reload();
  await node("old").waitFor();
  await editor.fill("保留已有指令");
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.store.setState({ boardOpen: false });
  });
  await page.waitForFunction(() => !document.querySelector(".canvas-stage.is-creation-mode"));
}
async function marquee() {
  const rect = await page.locator(".canvas-stage").boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 60);
  await page.mouse.down();
  await page.mouse.move(rect.x + 970, rect.y + 290, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll("[data-canvas-node-id].is-selected").length === 4, null, { timeout: 5000 });
  assert.equal(await page.locator("[data-canvas-node-id].is-selected").count(), 4);
}
async function addFromMenu(name) {
  await page.getByRole("menuitem", { name, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".ProseMirror [data-asset-id]").length > 0);
  assert.match(await editor.innerText(), /保留已有指令/);
  assert.equal(await page.getByRole("menu").count(), 0);
}

try {
  await page.goto("http://127.0.0.1:1456/scripts/fixtures/canvas-reference/preview.html");
  await node("old").waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot();
    const base = snapshot.nodes[0];
    snapshot.nodes = [
      { ...base, x: 60, y: 80 },
      { ...base, id: "a", assetId: "a", x: 280, y: 80 },
      { ...base, id: "duplicate-a", assetId: "a", x: 500, y: 80 },
      { ...base, id: "prompt", kind: "prompt", assetId: null, role: null, x: 720, y: 80,
        payloadJson: JSON.stringify({ schema_version: 1, text: "混选生成指令", status: "succeeded" }) },
      { ...base, id: "outside", assetId: "b", x: 60, y: 400 },
      { ...base, id: "agent", kind: "agent_group", assetId: null, role: null, x: 280, y: 400,
        payloadJson: JSON.stringify({ schema_version: 1, run_id: "test-run", status: "running" }) },
      { ...base, id: "group-image", assetId: "c", x: 500, y: 400 },
    ];
    snapshot.groups = [{ id: "folder", projectId: "p", name: "素材组", role: null,
      x: 500, y: 400, width: 204, height: 178, zIndex: 1, createdAt: 1, updatedAt: 1 }];
    snapshot.groupItems = [{ projectId: "p", groupId: "folder", nodeId: "group-image", ordinal: 0 }];
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  });

  await reset();
  await marquee();
  assert.deepEqual(await chips(), [], "selection alone must not insert references");
  await node("a").click({ button: "right", position: { x: 30, y: 30 } });
  await addFromMenu("添加所选 2 张图片到对话框");
  assert.deepEqual(await chips(), ["existing", "a"], "deduplicate images and skip execution cards");

  await reset();
  await marquee();
  await page.locator(".canvas-stage").click({ button: "right", position: { x: 20, y: 60 } });
  await addFromMenu("添加所选 2 张图片到对话框");
  assert.deepEqual(await chips(), ["existing", "a"], "blank-space menu keeps the marquee selection");

  await reset();
  await marquee();
  await node("prompt").click({ button: "right", position: { x: 30, y: 30 } });
  await addFromMenu("添加所选 2 张图片到对话框");
  assert.deepEqual(await chips(), ["existing", "a"], "mixed-selection card menu adds selected images");

  await reset();
  await marquee();
  await node("outside").click({ button: "right", position: { x: 30, y: 30 } });
  await addFromMenu("添加到对话框");
  assert.deepEqual(await chips(), ["b"], "right-clicking an unselected image targets only that image");

  await reset();
  await node("prompt").click({ button: "right", position: { x: 30, y: 30 } });
  assert.equal(await page.getByRole("menuitem", { name: /添加.*对话框/ }).count(), 0);

  // Removal is available only in context menus, including folders and execution cards.
  for (const id of ["old", "folder", "prompt", "agent"]) {
    await reset();
    await node(id).hover();
    assert.equal(await node(id).getByRole("button", { name: /移除|删除/ }).count(), 0);
    await marquee();
    assert.equal(await page.locator(".canvas-selection-delete").count(), 0);
    await node(id).focus();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    assert.equal(await page.locator("[data-canvas-node-id]").count(), 7, "keys cannot remove canvas content");
    // Clear the multi-selection before checking the single-node context action.
    await page.locator(".canvas-stage").click({ position: { x: 20, y: 60 } });
    await node(id).click({ button: "right", position: { x: 30, y: 30 } });
    await page.getByRole("menuitem", { name: "从画板移除", exact: true }).click();
    await node(id).waitFor({ state: "detached" });
    await page.keyboard.press("Control+z");
    await node(id).waitFor();
  }
  await reset();
  await marquee();
  await page.locator(".canvas-stage").click({ button: "right", position: { x: 20, y: 60 } });
  await page.getByRole("menuitem", { name: "从画板移除所选 4 项", exact: true }).click();
  for (const id of ["old", "a", "duplicate-a", "prompt"]) await node(id).waitFor({ state: "detached" });
  assert.equal(await node("outside").count(), 1, "unselected material stays on the canvas");
  assert.deepEqual(errors, []);
  console.log("PASS marquee to composer and context-menu-only removal: image/blank/card/group menus, keyboard safety, batch removal and undo");
} finally {
  await browser.close();
  await server.close();
}
