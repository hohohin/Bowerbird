import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1555, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.setDefaultTimeout(8000);
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const errors = []; page.on("pageerror", error => errors.push(error.message));
const root = "http://127.0.0.1:1555/scripts/fixtures/project-drop/preview.html";
const asset = id => page.locator(`[data-asset-id="${id}"]`).first();
const calls = () => page.evaluate(() => window.calls.filter(c => c.command === "add_assets_to_project"));
async function reset(suffix = "") { await page.goto(root + suffix); await asset("one").waitFor(); }
try {
  await reset();
  const card = page.locator('.library-project-folder[data-project-drop-id="p"]');
  await page.evaluate(() => {
    window.openedProjects = [];
    window.store.setState({ enterProject: async id => {
      if (window.failOpen) throw new Error("模拟打开失败");
      window.openedProjects.push(id);
    } });
  });
  const enter = card.getByRole("button", { name: "打开项目 目标项目" });
  await card.locator(".library-project-mosaic").click();
  await enter.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Space");
  assert.deepEqual(await page.evaluate(() => window.openedProjects), ["p", "p", "p"]);
  assert.equal(await card.isVisible(), true, "entering does not expand the card");
  assert.equal(await card.innerText(), "目标项目", "no asset count on project cards");
  await page.evaluate(() => window.store.setState({ projectRoutePending: true }));
  assert.equal(await enter.isDisabled(), true);
  await page.evaluate(() => { window.store.setState({ projectRoutePending: false }); window.failOpen = true; });
  await enter.click(); await page.getByText("模拟打开失败", { exact: true }).waitFor();
  await page.evaluate(() => window.failOpen = false);
  await asset("one").dragTo(card);
  await page.getByText("已向「目标项目」添加 1 张素材", { exact: true }).waitFor();
  assert.deepEqual((await calls())[0].args, { projectId: "p", assetIds: ["one"] });
  assert.equal(await card.locator(".library-project-expand").getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), null);
  await card.getByRole("button", { name: "展开项目 目标项目" }).click();
  const expanded = page.locator('.library-project-frame[data-project-drop-id="p"]');
  assert.deepEqual(await page.evaluate(() => window.openedProjects), ["p", "p", "p"], "expand and drag do not enter the project");
  // Drop directly on an existing image inside the project (capture bypasses the nested file-import handler).
  await asset("two").dragTo(expanded.locator('[data-asset-id="owned"]'));
  await expanded.locator('[data-asset-id="two"]').waitFor();
  await asset("two").dragTo(expanded.locator('[data-asset-id="owned"]'));
  await page.getByText("所选素材已在「目标项目」中", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().libraryMemberships.filter(m => m.projectId === "p" && m.assetId === "two").length), 1);
  // Sidebar targets cover empty projects and add a second membership rather than moving ownership.
  await asset("owned").dragTo(page.locator('.sidebar-nav-item[data-project-drop-id="q"]'));
  await page.getByText("已向「空项目」添加 1 张素材", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().libraryMemberships.filter(m => m.assetId === "owned").length), 2);
  await reset("?rail");
  await page.evaluate(() => window.store.setState({ mode: "manage", selectedIds: new Set(["one", "two"]) }));
  await asset("one").dragTo(page.locator('.app-sidebar-project-badge[data-project-drop-id="q"]'));
  await page.getByText("已向「空项目」添加 2 张素材", { exact: true }).waitFor();
  assert.deepEqual((await calls())[0].args.assetIds, ["one", "two"]);
  await reset();
  await page.evaluate(() => window.fail = true);
  await asset("one").dragTo(card);
  await page.getByText("模拟添加失败", { exact: true }).waitFor();
  assert.equal(await asset("one").isVisible(), true);
  assert.equal(await card.getAttribute("data-project-drop-state"), null);
  await page.evaluate(() => window.fail = false);
  await asset("one").dragTo(card);
  await page.getByText("已向「目标项目」添加 1 张素材", { exact: true }).waitFor();
  const before = (await calls()).length;
  await card.evaluate(element => {
    const dataTransfer = new DataTransfer(); dataTransfer.setData("text/plain", "three");
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  assert.equal((await calls()).length, before, "external text and stale payloads cannot add project members");
  assert.equal(await page.evaluate(() => window.store.getState().assets.length), 4);
  assert.deepEqual(errors, []);
  console.log("PASS project card: click/keyboard entry, pending/error handling, separate expansion; native thumbnail drag, collapsed/expanded targets, nested image drop, empty/sidebar/rail targets, multi-selection, duplicate membership, cross-project sharing, failure/retry, external-text rejection, no navigation on drop or deletion.");
} finally { await browser.close(); await server.close(); }
