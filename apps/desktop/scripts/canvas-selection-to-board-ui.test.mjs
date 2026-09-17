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
const editor = page.locator(".ProseMirror:not([aria-readonly])");
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
async function marquee(width = 970, height = 290, count = 4) {
  const rect = await page.locator(".canvas-stage").boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 60);
  await page.mouse.down();
  await page.mouse.move(rect.x + width, rect.y + height, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(count => document.querySelectorAll("[data-canvas-node-id].is-selected").length === count, count, { timeout: 5000 });
  assert.equal(await page.locator("[data-canvas-node-id].is-selected").count(), count);
}
async function addFromMenu(name) {
  await page.getByRole("menuitem", { name, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".ProseMirror:not([aria-readonly]) [data-asset-id]").length > 0);
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

  // Delete removes the actual marquee selection without requiring a node click.
  for (const [width, height, ids] of [
    [260, 290, ["old"]],
    [700, 290, ["old", "a", "duplicate-a"]],
    [970, 290, ["old", "a", "duplicate-a", "prompt"]],
    [970, 620, ["old", "a", "duplicate-a", "prompt", "outside", "agent", "folder"]],
  ]) {
    await reset();
    if (ids.length === 1) {
      await editor.focus();
      await page.evaluate(() => window.store.setState({ boardOpen: false }));
      await page.waitForFunction(() => !document.querySelector(".canvas-stage.is-creation-mode"));
    }
    await marquee(width, height, ids.length);
    await page.keyboard.press("Delete");
    for (const id of ids) await node(id).waitFor({ state: "detached", timeout: 5000 });
    assert.equal(await page.locator("[data-canvas-node-id]").count(), 7 - ids.length);
    await page.waitForFunction(ids => ids.filter(id => id !== "folder").every(id =>
      window.calls.some(call => call.command === "project_canvas_node_remove" && call.args.nodeId === id)), ids);
    assert.equal(await page.evaluate(() => window.calls.some(call => /delete_asset|generation.*delete/.test(call.command))), false);
    await page.keyboard.press("Control+z");
    for (const id of ids) await node(id).waitFor();
  }

  // Editing, other controls, and modal dialogs must not delete an existing selection.
  await reset();
  await marquee();
  await editor.fill("文字编辑保护");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  assert.equal((await editor.innerText()).trim(), "");
  assert.equal(await page.locator("[data-canvas-node-id]").count(), 7);
  await page.evaluate(() => { document.activeElement?.blur(); window.store.setState({ boardOpen: false }); });
  await page.getByRole("button", { name: "放大", exact: true }).focus();
  await page.keyboard.press("Delete");
  assert.equal(await page.locator("[data-canvas-node-id]").count(), 7);
  await page.locator(".canvas-stage").focus();
  await page.evaluate(() => {
    const dialog = document.createElement("div");
    dialog.id = "test-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
  });
  await page.keyboard.press("Delete");
  assert.equal(await page.locator("[data-canvas-node-id]").count(), 7);
  await page.evaluate(() => document.getElementById("test-modal").remove());
  await page.locator(".canvas-stage").click({ position: { x: 20, y: 60 } });
  await node("old").focus();
  await page.keyboard.press("Delete");
  assert.equal(await page.locator("[data-canvas-node-id]").count(), 7, "focus alone is not a selection");

  // Backspace stays disabled; context-menu removal and undo remain available.
  for (const id of ["old", "folder", "prompt", "agent"]) {
    await reset();
    await node(id).hover();
    assert.equal(await node(id).getByRole("button", { name: /移除|删除/ }).count(), 0);
    await marquee();
    assert.equal(await page.locator(".canvas-selection-delete").count(), 0);
    await node(id).focus();
    await page.keyboard.press("Backspace");
    assert.equal(await page.locator("[data-canvas-node-id]").count(), 7, "Backspace cannot remove canvas content");
    // Clear the multi-selection before checking the single-node context action.
    await page.locator(".canvas-stage").click({ position: { x: 20, y: 60 } });
    await node(id).click({ button: "right", position: { x: 30, y: 30 } });
    await page.getByRole("menuitem", { name: "从画布移出", exact: true }).click();
    await node(id).waitFor({ state: "detached" });
    await page.keyboard.press("Control+z");
    await node(id).waitFor();
  }
  await reset();
  await marquee();
  await page.locator(".canvas-stage").click({ button: "right", position: { x: 20, y: 60 } });
  await page.getByRole("menuitem", { name: "从画布移出所选 4 项", exact: true }).click();
  for (const id of ["old", "a", "duplicate-a", "prompt"]) await node(id).waitFor({ state: "detached" });
  assert.equal(await node("outside").count(), 1, "unselected material stays on the canvas");

  await reset();
  await marquee();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => ["old", "a", "duplicate-a", "prompt"].every(id =>
    window.snapshot().nodes.find(node => node.id === id)?.hiddenAt != null));
  await page.evaluate(() => window.save());
  await page.reload();
  await node("outside").waitFor();
  for (const id of ["old", "a", "duplicate-a", "prompt"]) assert.equal(await node(id).count(), 0);
  assert.equal(await page.evaluate(() => window.store.getState().assets.length), 5, "central assets survive removal and reload");
  assert.deepEqual(errors, []);
  console.log("PASS marquee references and Delete: single/multiple images, mixed cards, keyboard safety, context menus and undo");
} finally {
  await browser.close();
  await server.close();
}
