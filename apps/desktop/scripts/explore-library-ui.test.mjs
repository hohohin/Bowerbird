import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/explore-library-vite", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 750 }, reducedMotion: "reduce" });
page.setDefaultTimeout(8000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
await page.addInitScript(() => { window.total = 48; });

const directory = page.locator("[data-explore-directory]");
const middle = page.locator("[data-explore-middle]");
const cards = middle.locator(".catalog-scroller [data-asset-id]");
const scope = middle.locator(".explore-library-scope");
const heading = middle.locator(".explore-library-heading strong");
const headingFor = name => heading.filter({ hasText: name }).waitFor();
const dropTarget = element => element.evaluate(node => window.resolveExploreDrop(node));
const control = (name, value) => page.evaluate(({ name, value }) => window.explorePanel[name](value), { name, value });
const capture = (kind, id, assetId, revision) => control("setCapture", { assetId, revision, target: { kind, id } });
const newest = id => page.waitForFunction(id => document.querySelector("[data-explore-middle] .catalog-scroller [data-asset-id]")?.dataset.assetId === id, id);
const columns = value => page.locator(`[data-explore-middle] [data-columns="${value}"]`).first().waitFor();
const drop = (element, id, mediaKind = "image") => element.evaluate((target, { id, mediaKind }) => {
  const payload = new DataTransfer();
  payload.setData("application/x-bowerbird-explorer", JSON.stringify({ version: 1, mediaKind, imageUrl: `https://example.com/${id}.png`, pageUrl: "https://example.com/" }));
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: payload, clientX: 250, clientY: 240 }));
}, { id, mediaKind });
const commands = command => page.evaluate(command => window.requests.filter(request => request.command === command).map(request => request.args), command);
const project = directory.getByRole("button", { name: "项目A", exact: true });
const folder = directory.getByRole("treeitem", { name: "材质参考", exact: true });
const first = directory.getByRole("button", { name: "A 素材", exact: true });
const last = directory.getByRole("button", { name: "Z 末尾", exact: true });

async function verifyPreview() {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?explore-library`);
  await headingFor("全部素材");
  await cards.first().waitFor();
  await columns(3);
  assert.deepEqual(await dropTarget(scope), { kind: "global", id: null, projectId: null, disabled: false });
  assert.equal((await middle.boundingBox()).width, 360);
  await page.locator("[data-explore-library]").evaluate(el => el.style.setProperty("--explore-middle-width", "240px"));
  await columns(2);
  assert.equal((await middle.boundingBox()).width, 240);
  const scroller = middle.locator(".catalog-scroller");
  await scroller.evaluate(el => { el.scrollTop = 500; });
  await page.waitForFunction(() => document.querySelector("[data-explore-middle] .catalog-scroller").scrollTop === 500);
  await middle.getByRole("button", { name: "关闭素材流" }).click();
  assert.equal(await middle.evaluate(el => el.inert), true);
  assert.equal((await middle.boundingBox()).width, 0);
  await control("setMiddle", true);
  await columns(2);
  await cards.first().waitFor();
  assert.equal(await scroller.evaluate(el => el.scrollTop), 500);
  await capture("global", null, "asset-7", 1);
  await newest("asset-7");
  assert.equal(await scroller.evaluate(el => el.scrollTop), 0);
  await scroller.evaluate(el => { el.scrollTop = 420; });
  await page.waitForFunction(() => document.querySelector("[data-explore-middle] .catalog-scroller").scrollTop === 420);

  await project.click();
  await headingFor("项目A");
  assert.deepEqual(await dropTarget(scope), { kind: "project", id: "p", projectId: "p", disabled: false });
  assert.equal(await page.evaluate(() => window.exploreVisits?.length ?? 0), 0);
  await project.dblclick();
  await middle.getByRole("button", { name: "进画板" }).click();
  assert.deepEqual(await page.evaluate(() => window.exploreVisits), ["p", "p"]);
  await directory.getByRole("button", { name: "全部素材", exact: true }).click();
  await headingFor("全部素材");
  await newest("asset-7");
  assert.equal(await scroller.evaluate(el => el.scrollTop), 420);

  const offline = directory.getByRole("treeitem", { name: "离线参考", exact: true });
  assert.deepEqual(await dropTarget(offline), { kind: "folder", id: "offline", projectId: null, disabled: true });
  await folder.click();
  await headingFor("材质参考");
  await newest("asset-0");
  assert.equal(await middle.locator('[data-connection-entry="entry-3"]').count(), 0);
  assert.deepEqual(await dropTarget(scope), { kind: "folder", id: "wood", projectId: null, disabled: false });
  await capture("folder", "wood", "asset-2", 2);
  await newest("asset-2");
  assert.equal(await cards.first().evaluate(el => el.closest('[data-connection-entry]')?.dataset.connectionEntry), "entry-2");

  await directory.getByRole("button", { name: "标签模式", exact: true }).click();
  await last.click();
  await headingFor("Z 末尾");
  assert.deepEqual(await dropTarget(scope), { kind: "tag", id: "last", projectId: null, disabled: false });
  assert.deepEqual(await dropTarget(first), { kind: "tag", id: "first", projectId: null, disabled: false });
  assert.equal(await middle.locator("[data-catalog-section]").count(), 1);
  const before = await page.evaluate(() => window.requests.length);
  await capture("tag", "first", "asset-3", 3);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(before => window.requests.slice(before).some(call => call.args.filter?.firstAssetId === "asset-3"), before), false);
  await capture("tag", "last", "asset-4", 4);
  await newest("asset-4");
  assert.deepEqual(await page.evaluate(() => window.exploreVisits), ["p", "p"]);

  const openedWidth = (await directory.boundingBox()).width;
  await directory.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await middle.getByRole("button", { name: "关闭素材流" }).click();
  assert.equal(await directory.isVisible(), false);
  assert.equal((await middle.boundingBox()).width, 0);
  await control("setDock", true);
  await last.waitFor();
  assert.equal((await directory.boundingBox()).width, openedWidth);
  await control("setDock", false);
  await control("setActive", false);
  assert.equal(await directory.isVisible(), false);
  await control("setActive", true);
  await control("setMiddle", true);
  await headingFor("Z 末尾");
  await columns(2);
}

async function verifyCapture() {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?explore-library&capture`);
  await directory.getByRole("button", { name: "层级模式", exact: true }).click();
  await cards.first().waitFor();
  await project.click();
  await headingFor("项目A");
  await drop(scope, 7);
  await newest("asset-7");
  assert.equal((await commands("capture_source_browser_image")).at(-1).projectId, "p");
  const otherProject = directory.getByRole("button", { name: "项目B", exact: true });
  await drop(otherProject, 5, "video");
  await page.waitForFunction(() => window.requests.some(({ command, args }) => command === "capture_source_browser_image" && args.projectId === "q" && args.mediaKind === "video"));
  await headingFor("项目A");
  await newest("asset-7");

  await folder.click();
  await headingFor("材质参考");
  await drop(scope, 2);
  await newest("asset-2");
  assert.deepEqual((await commands("create_material_references")).at(-1), { assetIds: ["asset-2"], folderId: "wood" });
  await drop(folder, 1);
  await newest("asset-1");
  assert.deepEqual((await commands("create_material_references")).at(-1), { assetIds: ["asset-1"], folderId: "wood" });

  await directory.getByRole("button", { name: "标签模式", exact: true }).click();
  await last.click();
  await headingFor("Z 末尾");
  await drop(scope, 4);
  await newest("asset-4");
  assert.deepEqual((await commands("local_classification_example")).at(-1), { tagId: "last", assetIds: ["asset-4"], positive: true });
  assert.equal((await commands("capture_source_browser_image")).at(-1).skipClassification, true);
  await drop(first, 3);
  await page.waitForFunction(() => window.requests.some(({ command, args }) => command === "local_classification_example" && args.tagId === "first" && args.assetIds.includes("asset-3")));
  await headingFor("Z 末尾");
  await newest("asset-4");
}

try {
  await verifyPreview();
  await verifyCapture();
  assert.deepEqual(errors, []);
  console.log("PASS explore material stream: compact geometry, preserved scroll, preview routes, capture delivery and exact ordering, and directory dock.");
} finally {
  await browser.close();
  await server.close();
}
