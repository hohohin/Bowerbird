import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const output = ".tmp/library-navigation";
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
await page.addInitScript(() => { window.total = 4; });
const open = path => page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/${path}`);
const sidebar = () => page.getByRole("complementary", { name: "素材库导航", exact: true }).first();
const click = name => sidebar().getByRole("button", { name, exact: true }).click();
const sections = () => page.locator(".catalog-scroller:visible [data-catalog-section]").evaluateAll(values => values.map(node => node.dataset.catalogSection));
const sameGeometry = async expected => {
  const bounds = await Promise.all([sidebar().boundingBox(), page.locator(".catalog-scroller:visible").first().boundingBox()]);
  if (expected) assert.deepEqual(bounds, expected);
  return bounds;
};
const selected = count => page.getByRole("group", { name: "分类素材所选操作" }).getByText(`${count} 项`, { exact: true }).waitFor();

try {
  await open("catalog-paging/preview.html?split");
  await page.locator('[data-asset-id="asset-0"]').waitFor();
  assert.deepEqual(await sections(), ["all"]);
  assert.deepEqual(await page.locator(".catalog-scroller [data-asset-id]").evaluateAll(cards => cards.map(card => card.dataset.assetId)), ["asset-0","asset-1","asset-2","asset-3"]);
  const projects = sidebar().getByRole("button", { name: "项目", exact: true });
  assert.equal(await projects.locator("svg:not(.library-sidebar-chevron)").count(), 1);
  assert.equal(await sidebar().getByRole("button", { name: "项目A", exact: true }).locator("svg").count(), 0);
  const initial = await sameGeometry();
  const manageTags = sidebar().getByRole("button", { name: "标签管理", exact: true });
  await manageTags.getByText("标签管理", { exact: true }).waitFor();
  const tag = sidebar().getByRole("button", { name: "标签模式", exact: true });
  assert.equal(await tag.locator("span").isVisible(), false);
  await tag.hover();
  await tag.locator("span", { hasText: "标签模式" }).waitFor();
  assert.equal(await tag.locator("span svg").count(), 1);
  await sameGeometry(initial);

  await projects.click({ position: { x: 32, y: 14 } });
  assert.equal(await projects.getAttribute("aria-expanded"), "false");
  assert.equal(await projects.locator(".lucide-chevron-right").count(), 1);
  await sidebar().getByRole("button", { name: "项目A", exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(await sections(), ["all"]);
  await projects.press("Space");
  assert.equal(await projects.getAttribute("aria-expanded"), "true");
  assert.equal(await projects.locator(".lucide-chevron-down").count(), 1);
  await click("全部项目素材");
  await page.locator('[data-catalog-section="p"] .library-reference-badge').first().waitFor();
  assert.deepEqual(await sections(), ["p","q"]);
  await page.locator('[data-catalog-section="q"] [data-asset-id="asset-0"]').first().waitFor();
  assert.equal(await page.locator('[data-catalog-section="q"] .library-reference-badge').first().textContent(), "分身");
  assert.equal(await page.evaluate(() => window.requests.filter(request => request.command === "catalog_project_counts").length), 1);
  await sameGeometry(initial);
  await page.keyboard.press("Control+a");
  await selected(4);
  assert.deepEqual(await page.evaluate(() => window.requests.filter(request => request.command === "catalog_ids").map(request => request.args.filter.projectId)), ["p","q"]);
  await click("项目B");
  await page.waitForFunction(() => window.requests.some(request => request.command === "catalog_page" && request.args.filter.projectId === "q"));
  await page.locator('.catalog-scroller:visible [data-catalog-section="all"]').waitFor();
  assert.equal(await sidebar().getByRole("button", { name: "项目B", exact: true }).getAttribute("aria-current"), "true");
  await projects.click();
  assert.equal(await projects.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await sections(), ["all"]);
  await page.keyboard.press("e");
  await sidebar().getByRole("navigation", { name: "标签首字母索引" }).waitFor();
  await sameGeometry(initial);
  await page.waitForFunction(() => window.requests.some(request => request.command === "catalog_overview" && request.args.filter.kind === "tags" && request.args.filter.projectId === null));
  await sidebar().getByRole("button", { name: "Z 末尾", exact: true }).click();
  await sidebar().getByRole("button", { name: "Z 末尾", exact: true, current: "location" }).waitFor();
  const tagDisclosure = sidebar().getByRole("button", { name: "拼音 A–Z", exact: true });
  const tagScrollTop = await page.locator(".catalog-scroller:visible").evaluate(el => el.scrollTop);
  await tagDisclosure.click({ position: { x: 12, y: 14 } });
  assert.equal(await tagDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(await tagDisclosure.locator(".lucide-chevron-right").count(), 1);
  await sidebar().getByRole("navigation", { name: "标签首字母索引" }).waitFor({ state: "hidden" });
  assert.equal(await manageTags.isVisible(), true);
  assert.equal(await page.locator(".catalog-scroller:visible").evaluate(el => el.scrollTop), tagScrollTop);
  await tagDisclosure.press("Enter");
  assert.equal(await tagDisclosure.getAttribute("aria-expanded"), "true");
  await sidebar().getByRole("button", { name: "Z 末尾", exact: true, current: "location" }).waitFor();
  await page.locator(".catalog-scroller:visible").evaluate(el => { el.scrollTop = 0; });
  await sidebar().getByRole("button", { name: "A 素材", exact: true, current: "location" }).waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await tag.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("q");
  assert.equal(await projects.getAttribute("aria-expanded"), "false");
  await projects.click();
  assert.equal(await sidebar().getByRole("button", { name: "项目B", exact: true }).getAttribute("aria-current"), "true");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const stableSidebar = await sidebar().elementHandle();
  for (const key of ["e", "q", "e", "q"]) await page.keyboard.press(key);
  assert.equal(await stableSidebar.evaluate(element => element === document.querySelector(".library-sidebar")), true);
  assert.equal(await page.locator(":popover-open").count(), 0);
  await sameGeometry(initial);
  await page.screenshot({ path: `${output}/project.png` });

  const manager = page.getByRole("dialog", { name: "标签管理", exact: true });
  await manageTags.press("Enter");
  await manager.getByText("项目 · 项目B", { exact: true }).waitFor();
  await page.waitForFunction(() => window.requests.some(request => request.command === "project_classification_labels" && request.args.projectId === "q"));
  await page.keyboard.press("Escape");
  await manager.waitFor({ state: "hidden" });
  assert.equal(await manageTags.evaluate(button => button === document.activeElement), true);

  await manageTags.press("Enter");
  await manager.getByRole("button", { name: "#Z 末尾", exact: true }).click();
  await manager.waitFor({ state: "hidden" });
  const lastTag = sidebar().getByRole("button", { name: "Z 末尾", exact: true, current: "location" });
  await lastTag.waitFor();
  assert.ok(await page.locator(".catalog-scroller:visible").evaluate(element => element.scrollTop) > 0);
  assert.equal(await manageTags.evaluate(button => button === document.activeElement), true);

  const tagMenu = page.getByRole("menu", { name: "标签操作", exact: true });
  await lastTag.press("Shift+F10");
  await tagMenu.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "置顶标签");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const labelName = manager.getByRole("textbox", { name: "标签名称", exact: true });
  await labelName.waitFor();
  assert.equal(await labelName.inputValue(), "Z 末尾");
  await page.keyboard.press("Escape");
  await manager.waitFor({ state: "hidden" });
  assert.equal(await lastTag.evaluate(button => button === document.activeElement), true);

  await lastTag.click({ button: "right" });
  await tagMenu.getByRole("menuitem", { name: "删除标签", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "删除标签「Z 末尾」", exact: true });
  await confirmation.getByRole("button", { name: "取消", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "取消");
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.requests.some(request => request.command === "local_classification_delete_labels")), false);
  await manager.getByRole("button", { name: "关闭", exact: true }).click();
  await lastTag.click({ button: "right" });
  await tagMenu.getByRole("menuitem", { name: "管理全部标签", exact: true }).click();
  await manager.getByRole("button", { name: "#A 素材", exact: true }).waitFor();
  assert.equal(await labelName.count(), 0);
  await manager.getByRole("button", { name: "关闭", exact: true }).click();

  const searchTrigger = page.locator(".categorized-library:visible .file-view-heading").getByRole("button", { name: "搜索素材", exact: true });
  const search = page.getByRole("searchbox", { name: "搜索素材", exact: true });
  await searchTrigger.click();
  const searchRequests = () => page.evaluate(() => window.requests.filter(({ command, args }) =>
    command === "catalog_overview" && args.filter.query).map(({ args }) => args.filter.query));
  await search.evaluate(input => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    for (const value of ["s", "su", "sucai"]) {
      setValue.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, isComposing: true }));
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
  });
  await page.waitForTimeout(260);
  assert.equal(await search.inputValue(), "sucai");
  assert.deepEqual(await searchRequests(), []);
  await search.evaluate(input => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(input, "素材");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "素材" }));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "素材" }));
  });
  await page.waitForFunction(() => window.requests.some(({ command, args }) =>
    command === "catalog_overview" && args.filter.query === "素材"));
  assert.deepEqual(await searchRequests(), ["素材"]);
  await lastTag.waitFor();
  await page.getByRole("button", { name: "清空搜索", exact: true }).click();
  assert.equal(await searchTrigger.getAttribute("data-active"), null);
  assert.equal(await search.inputValue(), "");
  await search.fill("canceled");
  await page.getByRole("button", { name: "清空搜索", exact: true }).click();
  await search.fill("empty");
  await search.press("Enter");
  await page.getByText("没有匹配的素材。", { exact: true }).waitFor();
  assert.deepEqual(await searchRequests(), ["素材", "empty"]);
  await manageTags.click();
  await manager.getByRole("button", { name: "#Z 末尾", exact: true }).click();
  await lastTag.waitFor();
  assert.equal(await searchTrigger.getAttribute("data-active"), null);

  await page.setViewportSize({ width: 400, height: 760 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    assert.equal(await manageTags.getAttribute("title"), "标签管理");
    assert.equal(await manageTags.locator("span").isVisible(), false);
    await tagDisclosure.focus();
    await page.keyboard.press("Tab");
    assert.equal(await manageTags.evaluate(button => button === document.activeElement && button.matches(":focus-visible")), true);
    await page.keyboard.press("Enter");
    await manager.waitFor();
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "hidden" });
    assert.equal(await manageTags.evaluate(button => button === document.activeElement), true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.addInitScript(() => {
    if (location.search === "?pending-tags") {
      window.catalogGate = new Promise(resolve => { window.releaseInitialTags = resolve; });
    }
  });
  await open("catalog-paging/preview.html?pending-tags");
  await page.waitForFunction(() => window.changeKind);
  await page.evaluate(() => window.changeKind("tags"));
  await page.waitForFunction(() => window.requests.some(({ command, args }) =>
    command === "catalog_overview" && args.filter.kind === "tags"));
  await page.evaluate(() => { window.catalogGate = null; });
  await searchTrigger.click();
  await search.fill("empty");
  await search.press("Enter");
  await page.getByText("没有匹配的素材。", { exact: true }).waitFor();
  assert.equal(await lastTag.count(), 0);
  await page.evaluate(() => window.releaseInitialTags());
  await lastTag.waitFor();
  await page.getByRole("button", { name: "清空搜索", exact: true }).click();
  await sidebar().getByRole("button", { name: "A 素材", exact: true, current: "location" }).waitFor();
  await page.evaluate(() => window.changeKind("all"));
  await page.locator('.catalog-scroller [data-catalog-section="all"] [data-asset-id="asset-0"]').waitFor();
  const tagOverviewCount = await page.evaluate(() => {
    window.catalogGate = new Promise(resolve => { window.releaseCatalog = resolve; });
    return window.requests.filter(({ command, args }) =>
      command === "catalog_overview" && args.filter.kind === "tags").length;
  });
  await manageTags.click();
  await manager.getByRole("button", { name: "#Z 末尾", exact: true }).click();
  await page.waitForFunction(count => window.requests.filter(({ command, args }) =>
    command === "catalog_overview" && args.filter.kind === "tags").length > count, tagOverviewCount);
  const scrollWhileReading = await page.locator(".catalog-scroller:visible").evaluate(async viewport => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return viewport.scrollTop;
  });
  assert.equal(scrollWhileReading, 0, "the cached sections must keep their previous position until the latest overview arrives");
  await page.evaluate(() => window.mode.getState().setGeneratedFilter("source:generated"));
  await page.waitForFunction(() => window.requests.some(({ command, args }) =>
    command === "catalog_overview" && args.filter.kind === "tags" && args.filter.generated === true));
  await page.evaluate(() => { window.catalogGate = null; window.releaseCatalog(); });
  await lastTag.waitFor({ timeout: 5000 });
  await page.waitForFunction(() => {
    const viewport = document.querySelector(".catalog-scroller");
    const section = viewport?.querySelector('[data-catalog-section="last"]');
    return viewport?.scrollTop > 0 && section && Math.abs(section.getBoundingClientRect().top - viewport.getBoundingClientRect().top) < 2;
  });

  await open("connected-collections/preview.html");
  await sidebar().getByRole("treeitem", { name: "风景", exact: true }).waitFor();
  assert.equal(await sidebar().getByRole("treeitem", { name: "素材目录", exact: true }).locator("svg[data-folder-glyph]").count(), 1);
  assert.equal(await sidebar().getByRole("treeitem", { name: "风景", exact: true }).locator("svg[data-folder-glyph]").count(), 0);
  assert.deepEqual(await sections(), ["root","child","nested","empty","second","offline"]);
  const folders = sidebar().getByRole("button", { name: "文件夹", exact: true });
  await folders.click({ position: { x: 34, y: 14 } });
  assert.equal(await folders.getAttribute("aria-expanded"), "false");
  assert.equal(await folders.locator(".lucide-chevron-right").count(), 1);
  await sidebar().getByRole("tree", { name: "文件夹层级" }).waitFor({ state: "hidden" });
  assert.deepEqual(await sections(), ["root","child","nested","empty","second","offline"]);
  await folders.press("Space");
  assert.equal(await folders.getAttribute("aria-expanded"), "true");
  await sidebar().getByRole("treeitem", { name: "风景", exact: true }).click();
  await page.locator('[data-connection-entry="child-0"]').waitFor();
  assert.deepEqual(await sections(), ["child","nested"]);
  await page.locator('[data-connection-entry="child-0"] button').first().click({ modifiers: ["Control"] });
  await page.locator('[data-connection-entry="nested-0"] button').first().click({ modifiers: ["Shift"] });
  await selected(4);
  await page.keyboard.press("Control+a");
  await page.waitForFunction(() => window.requests.some(request => request.command === "connection_entry_ids" && request.args.subtree && request.args.folderId === "child"));
  await selected(4);
  assert.equal(await page.locator('[data-connection-entry^="root-"],[data-connection-entry="second-0"]').count(), 0);
  await page.screenshot({ path: `${output}/subtree.png` });
  await sidebar().getByRole("button", { name: "收起素材目录" }).click();
  await page.evaluate(async () => (await import("/src/lib/folderConnections.ts")).navigateConnectedFolder("nested"));
  await sidebar().getByRole("treeitem", { name: "晨间", exact: true, selected: true }).waitFor();
  await page.locator('[data-connection-entry="nested-0"]').waitFor();
  assert.deepEqual(await sections(), ["nested"]);

  await folders.click();
  assert.equal(await folders.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await sections(), ["nested"]);
  await page.keyboard.press("e");
  await sidebar().getByRole("button", { name: "拼音 A–Z", exact: true }).waitFor();
  await page.keyboard.press("q");
  assert.equal(await folders.getAttribute("aria-expanded"), "false");
  assert.equal(await sidebar().getByRole("button", { name: "连接文件夹", exact: true }).count(), 0);
  await page.locator(".app-topbar").getByRole("button", { name: "建立连接", exact: true }).waitFor();
  await click("新建文件夹");
  const newFolder = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  await newFolder.getByRole("textbox", { name: "文件夹名称" }).fill("空白测试目录");
  await newFolder.getByText("保存位置 /fixture/BowerbirdLibrary/空白测试目录", { exact: true }).waitFor();
  assert.equal(await newFolder.getByRole("button", { name: "更改父目录" }).count(), 0);
  assert.equal(await folders.getAttribute("aria-expanded"), "false");
  await newFolder.getByRole("button", { name: "保存", exact: true }).click();
  const created = sidebar().getByRole("treeitem", { name: "空白测试目录", exact: true, selected: true });
  await created.waitFor();
  assert.equal(await folders.getAttribute("aria-expanded"), "true");
  const createdId = await created.getAttribute("data-collection-id");
  await page.locator(`[data-catalog-section="${createdId}"]`).waitFor();
  assert.deepEqual(await sections(), [createdId]);
  assert.equal(await page.locator(".catalog-scroller:visible [data-connection-entry]").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.requests.filter(({ command }) =>
    ["create_connected_collection", "connect_folder", "plugin:dialog|open"].includes(command))), [
    { command: "create_connected_collection", args: { parentId: null, name: "空白测试目录", path: null, projectId: null } },
  ]);

  await sidebar().getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.reload();
  await sidebar().getByRole("button", { name: "展开侧栏", exact: true }).waitFor();
  await click("展开侧栏");
  assert.deepEqual(errors, []);
  console.log("PASS stable navigation, tag management and section jumps, scoped labels, keyboard focus, narrow light/dark sidebar, folder subtree and remembered sidebar");
} catch (error) {
  if (errors.length) console.error(errors);
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await server.close();
}
