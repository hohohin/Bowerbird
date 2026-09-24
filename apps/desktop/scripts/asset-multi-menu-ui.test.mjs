import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1458, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const multiMenu = () => page.getByRole("menu", { name: "已选 3 张素材的操作" });
async function callsOf(command) {
  return page.evaluate((cmd) => window.calls.filter((call) => call.command === cmd), command);
}
async function storeState() {
  return page.evaluate(() => {
    const s = window.fixtureStore.getState();
    return { mode: s.mode, folder: s.currentFolderId, selected: s.selectedIds.size };
  });
}
try {
  await page.goto("http://127.0.0.1:1458/scripts/fixtures/asset-multi-menu/preview.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator('[data-asset-id="a1"]').waitFor();

  // 1) 多选右键 → 批量菜单：单图专属项全部消失，批量项齐全（全局视图无「移出当前项目」）。
  await page.locator('[data-asset-id="a1"]').click({ button: "right" });
  const menu = multiMenu();
  await menu.waitFor();
  assert.equal(await menu.locator(".asset-context-column").count(), 1, "multi menu is single column");
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox.width <= 249, `multi menu stays narrow, got ${menuBox.width}px`);
  for (const name of ["打开图片详情", "重命名", "图片标注", "分层编辑", "打开所在文件夹", "用系统程序打开", "复制文件路径", "复制图片", "反推提示词", "移出当前项目"]) {
    assert.equal(await menu.getByRole("menuitem", { name, exact: true }).count(), 0, `single-only item「${name}」must be absent`);
  }
  for (const name of ["用选中的内容新建集合", "移入已有集合", "加入项目", "批量反推", "移出园丁鸟", "物理删除"]) {
    assert.equal(await menu.getByRole("menuitem", { name, exact: true }).count(), 1, `batch item「${name}」present`);
  }
  await page.keyboard.press("Escape");
  assert.equal(await multiMenu().count(), 0);

  // 2) 移入已有集合：二级菜单只列普通集合（排除 root/智能夹/收藏夹），点击整批移入并跳转。
  await page.locator('[data-asset-id="a2"]').click({ button: "right" });
  await multiMenu().waitFor();
  await menu.getByRole("menuitem", { name: "移入已有集合" }).hover();
  const sub = page.getByRole("menu", { name: "选择要移入的集合" });
  await sub.waitFor();
  assert.deepEqual((await sub.getByRole("menuitem").allTextContents()).sort(), ["待整理", "设计参考"]);
  await page.evaluate(() => { window.calls.length = 0; });
  await sub.getByRole("menuitem", { name: "设计参考" }).click();
  await page.getByText("素材已移入集合").waitFor();
  const moveCalls = await callsOf("move_assets_to_folder");
  assert.equal(moveCalls.length, 1);
  assert.deepEqual([...moveCalls[0].args.assetIds].sort(), ["a1", "a2", "a3"]);
  assert.equal(moveCalls[0].args.folderId, "f1");
  assert.equal(await multiMenu().count(), 0, "menu closes after move");
  assert.deepEqual(await storeState(), { mode: "browse", folder: "f1", selected: 0 });

  // 3) 用选中的内容新建集合：命名弹窗 → 建集合 + 整批移入 + 跳转。
  await page.evaluate(() => window.resetSelection());
  await page.locator('[data-asset-id="a1"]').click({ button: "right" });
  await multiMenu().waitFor();
  await menu.getByRole("menuitem", { name: "用选中的内容新建集合" }).click();
  const createDialog = page.getByRole("dialog", { name: "用选中的内容新建集合" });
  await createDialog.waitFor();
  await page.locator("#batch-new-collection-input").fill("灵感集");
  await page.evaluate(() => { window.calls.length = 0; });
  await createDialog.getByRole("button", { name: "创建集合并移入" }).click();
  await page.getByText("已新建集合并移入选中素材").waitFor();
  const createCalls = await callsOf("create_folder");
  const moveToNew = await callsOf("move_assets_to_folder");
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].args.name, "灵感集");
  assert.equal(moveToNew.length, 1);
  assert.equal(moveToNew[0].args.folderId, "new-灵感集");
  assert.deepEqual([...moveToNew[0].args.assetIds].sort(), ["a1", "a2", "a3"]);
  assert.deepEqual(await storeState(), { mode: "browse", folder: "new-灵感集", selected: 0 });

  // 4) 加入项目：小面板勾选（可多选）后批量加入。
  await page.evaluate(() => window.resetSelection());
  await page.locator('[data-asset-id="a3"]').click({ button: "right" });
  await multiMenu().waitFor();
  await menu.getByRole("menuitem", { name: "加入项目" }).click();
  const projectDialog = page.getByRole("dialog", { name: "加入项目" });
  await projectDialog.waitFor();
  await projectDialog.getByText("画册项目", { exact: true }).click();
  await projectDialog.getByText("网站改版", { exact: true }).click();
  await page.evaluate(() => { window.calls.length = 0; });
  await projectDialog.getByRole("button", { name: "加入所选 2 个项目" }).click();
  await page.getByText("素材已加入 2 个项目").waitFor();
  const addCalls = await callsOf("add_assets_to_project");
  assert.deepEqual(addCalls.map((call) => call.args.projectId).sort(), ["p1", "p2"]);
  for (const call of addCalls) assert.deepEqual([...call.args.assetIds].sort(), ["a1", "a2", "a3"]);
  assert.equal((await storeState()).mode, "browse");

  // 5) 批量反推：二级引擎选择浮层；免费档 codex 置灰并在 tooltip 说明原因。
  await page.evaluate(() => window.resetSelection());
  await page.locator('[data-asset-id="a1"]').click({ button: "right" });
  await multiMenu().waitFor();
  await menu.getByRole("menuitem", { name: "批量反推" }).click();
  const picker = page.locator("#describe-provider-picker");
  await picker.waitFor();
  const codexOption = picker.locator("button", { hasText: "本机 codex" });
  assert.ok(await codexOption.isDisabled(), "free tier codex option disabled");
  assert.equal(await codexOption.getAttribute("title"), "升级 Pro 解锁本机 codex");
  assert.ok(!(await picker.locator("button", { hasText: "Bowerbird Cloud" }).isDisabled()), "cloud option usable");
  assert.equal(await multiMenu().count(), 0, "menu closes after opening provider picker");
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });

  // 6) 批量物理删除：确认弹窗显示数量，确认后逐张删除。
  await page.evaluate(() => window.resetSelection());
  await page.evaluate(() => { window.deleted = []; });
  await page.locator('[data-asset-id="a2"]').click({ button: "right" });
  await multiMenu().waitFor();
  await menu.getByRole("menuitem", { name: "物理删除" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "物理删除 3 张素材" });
  await deleteDialog.waitFor();
  await deleteDialog.getByRole("button", { name: "物理删除", exact: true }).click();
  await page.getByText("已物理删除 3 张素材").waitFor();
  const deletedArgs = await page.evaluate(() => window.deleted);
  assert.deepEqual(deletedArgs.map((args) => args.id).sort(), ["a1", "a2", "a3"]);
  assert.ok(deletedArgs.every((args) => args.mode === "delete"));
  assert.equal((await storeState()).mode, "browse");

  // 7) 单选回归：选中 1 张时右键仍是原单图菜单。
  await page.evaluate(() => window.fixtureStore.setState({ mode: "manage", selectedIds: new Set(["a1"]) }));
  await page.locator('[data-asset-id="a1"]').click({ button: "right" });
  const singleMenu = page.getByRole("menu", { name: "素材操作" });
  await singleMenu.waitFor();
  assert.ok((await singleMenu.getByRole("menuitem", { name: "打开图片详情" }).count()) === 1, "single menu keeps detail entry");
  assert.equal(await singleMenu.getByRole("menuitem", { name: "用选中的内容新建集合" }).count(), 0);
  assert.equal(await singleMenu.getByRole("menuitem", { name: "批量反推" }).count(), 0);

  assert.deepEqual(errors, []);
  console.log("PASS asset multi menu: batch items, single-only removal, collection submenu, new-collection dialog, project picker, describe provider gating, batch delete confirm, single-menu fallback");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
