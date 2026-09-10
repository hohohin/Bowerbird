import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { createRequire } from "node:module";
const requireRenderer = createRequire(new URL("../../html-renderer/package.json", import.meta.url));
const { chromium } = process.env.BOWERBIRD_PLAYWRIGHT_MODULE ? await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE) : requireRenderer("playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1441, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const dialog = page.getByRole("dialog");
async function snapshot() {
  return page.evaluate(() => {
    const s = window.fixtureStore.getState();
    return { assets: s.assets.map((a) => a.id), folder: s.currentFolderId, collection: s.currentCollectionId,
      search: s.searchQuery, selected: [...s.selectedIds], detail: s.detailAssetId,
      scroll: document.querySelector("#home").scrollTop };
  });
}
try {
  await page.goto("http://127.0.0.1:1441/scripts/fixtures/collection-panel/preview.html");
  await page.getByRole("button", { name: "设计参考", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "全部素材", exact: true }).count(), 0);
  await page.locator("#home").evaluate((el) => { el.scrollTop = 300; });
  const before = await snapshot();
  await page.getByRole("button", { name: "设计参考", exact: true }).focus();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "预览 集合素材一", exact: true }).waitFor();
  assert.match(await dialog.innerText(), /2 张素材/);
  assert.ok((await dialog.locator(".app-modal-header").boundingBox()).height <= 46, "collection header stays one button high");
  assert.equal(await dialog.getByText("首页素材 0", { exact: true }).count(), 0);
  assert.deepEqual(await snapshot(), before);
  await mkdir(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/collection-panel.png", animations: "disabled" });
  await dialog.getByRole("button", { name: "预览 集合素材一", exact: true }).click();
  await dialog.getByRole("img", { name: "集合素材一", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "返回集合" }).click();
  await page.evaluate(() => window.refreshCollection());
  await dialog.getByRole("button", { name: "预览 集合素材二", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await snapshot(), before);
  assert.equal(await page.getByRole("button", { name: "设计参考", exact: true }).evaluate((el) => el === document.activeElement), true);
  await page.getByRole("button", { name: "空集合", exact: true }).click();
  await dialog.getByText("这个集合还没有素材").waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "重试集合", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  await page.evaluate(() => { window.failure = false; });
  await dialog.getByRole("button", { name: "重新加载" }).click();
  await dialog.getByRole("button", { name: "预览 集合素材一", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "慢速集合", exact: true }).click();
  await dialog.getByRole("status").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "空集合", exact: true }).click();
  await dialog.getByText("这个集合还没有素材").waitFor();
  await page.waitForTimeout(400);
  assert.equal(await dialog.getByRole("button", { name: "预览 集合素材一", exact: true }).count(), 0);
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(await snapshot(), before);
  // Native scrollbar never reserves right-hand space, while the panel still scrolls.
  await page.getByRole("button", { name: "滚动集合", exact: true }).click();
  await dialog.getByRole("button", { name: "预览 首页素材 39", exact: true }).waitFor();
  const viewport = dialog.locator(".collection-scroll-viewport");
  const scrollMetrics = await viewport.evaluate((el) => {
    el.scrollTop = 160;
    const content = el.firstElementChild;
    return { gutter: el.offsetWidth - el.clientWidth, scroll: el.scrollTop,
      left: getComputedStyle(content).paddingLeft, right: getComputedStyle(content).paddingRight };
  });
  assert.equal(scrollMetrics.gutter, 0);
  assert.equal(scrollMetrics.left, scrollMetrics.right);
  assert.equal(scrollMetrics.scroll, 160);
  const scrollbar = dialog.getByRole("scrollbar", { name: "集合素材滚动条" });
  await page.waitForFunction(() => document.querySelector('.collection-scroll-rail')?.getAttribute('data-visible') === 'true');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.collection-scroll-rail')).opacity === '1');
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.collection-scroll-rail')).opacity === '0');
  const railBox = await scrollbar.boundingBox();
  assert.equal(await scrollbar.evaluate((el) => getComputedStyle(el).width), "14px");
  await page.mouse.move(railBox.x + 7, railBox.y + 40);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.collection-scroll-rail')).opacity === '1');
  const thumbBox = await dialog.locator('.collection-scroll-thumb').boundingBox();
  await page.mouse.move(thumbBox.x + 2, thumbBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(thumbBox.x + 2, thumbBox.y + 58);
  await page.mouse.up();
  assert.ok(await viewport.evaluate((el) => el.scrollTop > 160));
  const beforeWheel = await viewport.evaluate((el) => el.scrollTop);
  await page.mouse.move(railBox.x + 7, railBox.y + 40);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction((top) => document.querySelector('.collection-scroll-viewport').scrollTop > top, beforeWheel);
  await scrollbar.focus();
  await page.keyboard.press("End");
  assert.ok(await viewport.evaluate((el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 1));
  await page.screenshot({ path: ".tmp/collection-scrollbar.png", animations: "disabled" });
  await page.keyboard.press("Escape");

  const addRegion = page.getByRole("region", { name: "添加素材模式" });
  async function startAdding() {
    await page.getByRole("button", { name: "设计参考", exact: true }).click();
    await dialog.getByRole("button", { name: "添加素材", exact: true }).click();
    await addRegion.waitFor();
    assert.equal(await dialog.count(), 0);
    assert.match(await addRegion.innerText(), /添加素材中-目标集合：设计参考/);
    assert.equal(await page.evaluate(() => window.fixtureStore.getState().mode), "manage");
    assert.equal(await addRegion.getByRole("button", { name: "完成添加" }).isDisabled(), true);
  }
  const moveCalls = () => page.evaluate(() => window.calls.filter((call) => call.command === "move_assets_to_folder"));
  await startAdding();
  assert.equal(await addRegion.getByRole("button", { name: "退出添加" }).getAttribute("title"), "或者按esc退出");
  await page.locator('#home [data-asset-id="home-0"]').click();
  await page.locator('#home [data-asset-id="home-1"]').click();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().selectedIds.size), 2);
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().detailAssetId), null);
  await page.locator('#home [data-asset-id="home-0"]').click();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().selectedIds.size), 1);
  await page.keyboard.press("Escape");
  await addRegion.waitFor({ state: "detached" });
  assert.equal((await moveCalls()).length, 0);
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().mode), "browse");
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().selectedIds.size), 0);

  await startAdding();
  await addRegion.getByRole("button", { name: "退出添加" }).click();
  assert.equal((await moveCalls()).length, 0);
  await startAdding();
  await page.locator('#home [data-asset-id="home-0"]').click();
  await page.locator('#home [data-asset-id="home-1"]').click();
  await page.screenshot({ path: ".tmp/collection-add-mode.png", animations: "disabled" });
  await page.evaluate(() => { window.failAdd = true; });
  await addRegion.getByRole("button", { name: "完成添加" }).click();
  await page.waitForFunction(() => !window.fixtureStore.getState().collectionAddBusy && window.calls.some((call) => call.command === "move_assets_to_folder"));
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().selectedIds.size), 2);
  assert.equal(await addRegion.count(), 1);
  await page.evaluate(() => { window.failAdd = false; window.holdAdd = true; });
  await addRegion.getByRole("button", { name: "完成添加" }).click();
  await page.waitForFunction(() => !!window.releaseAdd);
  assert.equal(await addRegion.getByRole("button", { name: "正在添加…" }).isDisabled(), true);
  assert.equal(await addRegion.getByRole("button", { name: "退出添加" }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.locator('#home [data-asset-id="home-2"]').click();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().selectedIds.size), 2);
  assert.equal(await addRegion.count(), 1);
  await page.evaluate(() => window.releaseAdd());
  await dialog.getByRole("button", { name: "预览 首页素材 0", exact: true }).waitFor();
  assert.match(await dialog.innerText(), /4 张素材/);
  assert.equal(await addRegion.count(), 0);
  const calls = await moveCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, { assetIds: ["home-0", "home-1"], folderId: "one" });
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().mode), "browse");
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().selectedIds.size), 0);
  await page.keyboard.press("Escape");
  // Returning from a project uses the existing flush/route boundary; a failed save cannot start picking.
  const failedRoute = await page.evaluate(async () => {
    const store = window.fixtureStore;
    store.setState({ activeProjectId: "project", projectCanvasFlush: async () => { throw new Error("未保存画板"); } });
    try { await store.getState().beginCollectionAdd("one"); } catch { /* expected */ }
    return { project: store.getState().activeProjectId, target: store.getState().collectionAddTargetId };
  });
  assert.deepEqual(failedRoute, { project: "project", target: null });
  const successfulRoute = await page.evaluate(async () => {
    const store = window.fixtureStore;
    store.setState({ projectCanvasFlush: null });
    await store.getState().beginCollectionAdd("one");
    return { project: store.getState().activeProjectId, target: store.getState().collectionAddTargetId, mode: store.getState().mode };
  });
  assert.deepEqual(successfulRoute, { project: null, target: "one", mode: "manage" });
  await page.keyboard.press("Escape");
  // Paste/drop import stays in this collection and never falls through to the home paste handler.
  await page.getByRole("button", { name: "设计参考", exact: true }).click();
  await dialog.getByText("支持粘贴图片或拖入文件", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.globalPasteCount = 0;
    window.addEventListener("paste", () => { window.globalPasteCount += 1; });
  });
  async function transfer(kind, names) {
    await page.evaluate(({ kind, names }) => {
      const panel = document.querySelector('.collection-panel .app-modal');
      const data = new DataTransfer();
      for (const name of names) data.items.add(new File([new Uint8Array([137, 80, 78, 71])], name, { type: name.endsWith('.txt') ? 'text/plain' : 'image/png' }));
      if (kind === 'paste') panel.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      else {
        panel.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
        panel.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      }
    }, { kind, names });
  }
  const beforeImport = await snapshot();
  await transfer('paste', ['paste.png']);
  await dialog.getByRole('button', { name: '预览 paste.png', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.globalPasteCount), 0);
  await transfer('drop', ['drop-a.png', 'invalid.txt', 'drop-b.png']);
  await dialog.getByRole('button', { name: '预览 drop-b.png', exact: true }).waitFor();
  await dialog.getByRole('alert').filter({ hasText: 'invalid.txt' }).waitFor();
  assert.deepEqual(await snapshot(), beforeImport);
  const importCalls = await page.evaluate(() => window.calls.filter((call) => call.command === 'import_image_bytes'));
  assert.deepEqual(importCalls.map((call) => [call.args.fileName, call.args.source, call.args.projectId]), [
    ['paste.png', 'clipboard', null], ['drop-a.png', 'imported', null], ['invalid.txt', 'imported', null], ['drop-b.png', 'imported', null],
  ]);
  assert.deepEqual((await moveCalls()).slice(-3).map((call) => call.args), [
    { assetIds: ['import-paste.png'], folderId: 'one' }, { assetIds: ['import-drop-a.png'], folderId: 'one' }, { assetIds: ['import-drop-b.png'], folderId: 'one' },
  ]);
  await page.evaluate(() => { window.failImportLink = true; });
  await transfer('drop', ['unlinked.png']);
  await dialog.getByRole('alert').filter({ hasText: '已入素材库，但加入集合失败' }).waitFor();
  await page.evaluate(() => { window.failImportLink = false; window.holdImport = true; });
  await transfer('paste', ['waiting.png']);
  await page.waitForFunction(() => !!window.releaseImport);
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: '提炼视觉规范', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 1);
  await transfer('paste', ['duplicate.png']);
  assert.equal(await page.evaluate(() => window.calls.some((call) => call.command === 'import_image_bytes' && call.args.fileName === 'duplicate.png')), false);
  await page.evaluate(() => { window.holdImport = false; window.releaseImport(); });
  await dialog.getByRole('button', { name: '预览 waiting.png', exact: true }).waitFor();
  await page.screenshot({ path: '.tmp/collection-import.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  // A collection opens its independent guide without creating or switching projects.
  await page.getByRole("button", { name: "设计参考", exact: true }).click();
  await dialog.getByRole("button", { name: "提炼视觉规范", exact: true }).click();
  await page.waitForFunction(() => window.calls.some((call) => call.command === "visual_profile_preview" && call.args.folderId === "one" && !("projectId" in call.args)));
  await page.getByRole("heading", { name: "提炼视觉规范" }).waitFor();
  assert.equal(await page.locator('.collection-panel').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.fixtureStore.getState().visualProfileFolder), { id: "one", name: "设计参考" });
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeProjectId), null);
  await page.evaluate(() => window.fixtureStore.getState().closeVisualProfile());
  await page.getByRole("button", { name: "设计参考", exact: true }).click();
  await dialog.getByRole("button", { name: "提炼视觉规范", exact: true }).click();
  await page.getByRole("heading", { name: "提炼视觉规范" }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "规范所属项目" }).count(), 0);
  assert.equal(await page.evaluate(() => window.calls.some((call) => /visual_profile_(cloud_)?extract/.test(call.command))), false);
  assert.deepEqual(errors, []);
  console.log("Collection panel and add mode: isolation, overlay scrollbar spacing, selection, cancel/Esc, retry, busy guard and exact submit passed.");
} finally {
  await browser.close();
  await server.close();
}
