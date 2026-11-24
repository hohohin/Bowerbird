import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const output = ".tmp/capture-drop-target";
const server = await createServer({
  cacheDir: `${output}/vite`,
  server: { host: "127.0.0.1", port: 17939, strictPort: true, hmr: false, watch: null },
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1640, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://image.test/**", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#4868ff"/></svg>',
  }));
  await page.goto("http://127.0.0.1:17939/scripts/fixtures/connected-collections/preview.html?capture-drop");
  const left = page.locator('[data-library-pane="home-left"]');
  const right = page.locator('[data-library-pane="home-pane-1"]');
  const hint = page.locator("[data-capture-drop-hint]");
  const marker = "[data-capture-drop-target]";
  const section = (pane, id) => pane.locator(`[data-catalog-section="${id}"]`);
  const row = (pane, id) => pane.locator(`[data-collection-id="${id}"]`);
  const calls = command => page.evaluate(command => window.requests.filter(call => call.command === command), command);
  const waitForCall = (command, count) => page.waitForFunction(({ command, count }) =>
    window.requests.filter(call => call.command === command).length === count, { command, count });
  const heading = target => target.locator(".catalog-section-title");
  const clear = async () => {
    await hint.waitFor({ state: "hidden" });
    assert.equal(await page.locator(marker).count(), 0);
  };
  let sequence = 0;
  async function dispatch(target, event, source) {
    await target.evaluate((element, { event, source, sequence }) => {
      const rect = element.getBoundingClientRect();
      const clientX = rect.x + rect.width / 2, clientY = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(clientX, clientY);
      if (!hit || !element.contains(hit)) throw new Error(`Drop target is covered: ${element.textContent}`);
      if (event === "dragover" && source) {
        const data = new DataTransfer();
        if (source === "explorer") {
          data.setData("application/x-bowerbird-explorer", JSON.stringify({
            version: 1, dragId: sequence.toString(16).padStart(32, "0"),
            imageUrl: `https://image.test/${sequence}.png`, pageUrl: "https://www.pinterest.com/pin/1",
          }));
        } else {
          const file = new File([new Uint8Array([1])], `local-${sequence}.png`, { type: "image/png" });
          Object.defineProperty(file, "path", { value: `D:/fixture/${file.name}` });
          data.items.add(file);
        }
        window.captureDrag = data;
      }
      hit.dispatchEvent(new DragEvent(event, { bubbles: true, cancelable: true, dataTransfer: window.captureDrag, clientX, clientY }));
    }, { event, source, sequence });
  }
  async function hover(target, source, message) {
    ++sequence;
    await dispatch(target, "dragover", source);
    await hint.filter({ hasText: message }).waitFor();
    assert.equal(await hint.innerText(), message);
    assert.equal(await hint.evaluate(element => getComputedStyle(element).pointerEvents), "none");
  }
  async function drop(target) { await dispatch(target, "drop"); await clear(); }
  async function marked(target, value = "ready") { assert.equal(await target.getAttribute("data-capture-drop-target"), value); }
  async function leave(from, to) { await from.dispatchEvent("dragleave", { relatedTarget: await to.elementHandle() }); }
  async function checkFrame(target) {
    const geometry = await target.evaluate(section => {
      const frame = getComputedStyle(section, "::before");
      return { height: section.getBoundingClientRect().height, frameHeight: Number.parseFloat(frame.height),
        widths: [frame.borderTopWidth, frame.borderRightWidth, frame.borderBottomWidth, frame.borderLeftWidth],
        frameLayer: Number(frame.zIndex), titleLayer: Number(getComputedStyle(section.querySelector(".catalog-section-heading")).zIndex) };
    });
    assert.ok(Math.abs(geometry.frameHeight - geometry.height) < 1, "outline spans the full virtual section height");
    assert.deepEqual(geometry.widths, ["1px", "2px", "1px", "2px"]);
    assert.ok(geometry.titleLayer > geometry.frameLayer, "sticky title stays above the frame");
  }

  await left.locator('[data-connection-entry="root-0"]').waitFor();
  await left.locator(".catalog-scroller").evaluate(scroller => {
    scroller.scrollTop = scroller.querySelector('[data-catalog-section="child"]').offsetTop - 160;
  });
  const child = section(left, "child");
  await heading(child).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-collection-id="root"]')?.getAttribute("aria-selected") === "true");
  assert.equal(await left.locator(".catalog-section-heading.is-pinned .catalog-section-title").textContent(), "素材目录");

  for (const [index, source] of ["explorer", "local"].entries()) {
    await hover(heading(child), source, "素材即将采集到文件夹【风景】中");
    await marked(child);
    await marked(row(left, "child"));
    assert.equal(await section(left, "root").getAttribute("data-capture-drop-target"), null);
    if (source === "explorer") {
      await checkFrame(child);
      const bubble = await hint.elementHandle();
      assert.equal(await hint.evaluate(node => getComputedStyle(node).animationName), "none");
      const nestedHeading = heading(section(left, "nested"));
      await leave(heading(child), nestedHeading);
      await marked(child);
      await dispatch(nestedHeading, "dragover");
      await hint.filter({ hasText: "文件夹【晨间】" }).waitFor();
      await marked(section(left, "nested"));
      assert.equal(await child.getAttribute("data-capture-drop-target"), null);
      await leave(nestedHeading, row(left, "child"));
      await dispatch(row(left, "child"), "dragover");
      await hint.filter({ hasText: "文件夹【风景】" }).waitFor();
      await leave(row(left, "child"), heading(child));
      assert.equal(await hint.evaluate((node, original) => node === original, bubble), true, "the same bubble survives section and sidebar transitions");
      await dispatch(heading(child), "dragover");
      await page.screenshot({ path: `${output}/folder-dark.png` });
    }
    await drop(heading(child));
    await waitForCall("create_material_references", index + 1);
    assert.equal((await calls("create_material_references")).at(-1).args.folderId, "child");
  }
  assert.equal((await calls("capture_source_browser_image"))[0].args.projectId, null);
  assert.equal((await calls("import_files"))[0].args.projectId, null);

  await row(left, "nested").click();
  const empty = section(left, "empty");
  await heading(empty).waitFor();
  assert.equal((await empty.boundingBox()).height, 40);
  await hover(heading(empty), "local", "素材即将采集到文件夹【空集合】中");
  await marked(empty);
  await checkFrame(empty);
  await drop(heading(empty));
  await waitForCall("create_material_references", 3);
  assert.equal((await calls("create_material_references")).at(-1).args.folderId, "empty");

  await row(left, "offline").click();
  const offline = section(left, "offline");
  const disabledText = "文件夹【离线目录】已离线，无法采集到此位置";
  await hover(heading(offline), "explorer", disabledText);
  await marked(offline, "blocked");
  await marked(row(left, "offline"), "blocked");
  await drop(heading(offline));
  await hover(row(left, "offline"), "local", disabledText);
  await marked(offline, "blocked");
  await drop(row(left, "offline"));
  const offlineChild = section(left, "offline-child");
  const offlineChildRow = row(left, "offline-child");
  const childOfflineText = "文件夹【离线子目录】已离线，无法采集到此位置";
  assert.equal(await offlineChild.getAttribute("data-file-import-collection-available"), "false");
  assert.equal(await offlineChildRow.getAttribute("data-file-import-collection-available"), "false");
  await page.evaluate(next => window.explorerDrag({ phase: "start", id: next.toString(16).padStart(32, "0"), imageUrl: `https://image.test/${next}.png` }), sequence + 1);
  await hover(heading(offlineChild), "explorer", childOfflineText);
  const dragVisual = page.locator("[data-explorer-drag-visual]");
  await dragVisual.locator(".card").waitFor();
  await marked(offlineChildRow, "blocked");
  assert.equal(await offlineChild.evaluate(node => getComputedStyle(node, "::before").borderLeftStyle), "dashed");
  await page.screenshot({ path: `${output}/offline-dark.png` });
  await drop(heading(offlineChild));
  assert.ok((await calls("release_source_browser_analysis")).some(call => call.args.dragId === sequence.toString(16).padStart(32, "0")), "the rejected drop reaches Explorer and releases its analysis");
  assert.equal(await dragVisual.count(), 0, "a rejected drop removes the drag visual without waiting for native dragend");
  await hover(offlineChildRow, "local", childOfflineText);
  await marked(offlineChild, "blocked");
  await drop(offlineChildRow);
  assert.equal((await calls("capture_source_browser_image")).length, 1);
  assert.equal((await calls("import_files")).length, 2);
  assert.equal((await calls("create_material_references")).length, 3);

  await left.getByRole("button", { name: "向右分栏" }).click();
  await row(right, "offline").waitFor();
  await hover(row(right, "offline"), "local", disabledText);
  await marked(row(right, "offline"), "blocked");
  assert.equal(await left.locator(marker).count(), 0);
  const [hintBounds, rightBounds] = await Promise.all([hint.boundingBox(), right.boundingBox()]);
  assert.ok(hintBounds.x >= rightBounds.x - 1 && hintBounds.x + hintBounds.width <= rightBounds.x + rightBounds.width + 1, "bubble stays within the target column");
  await leave(row(right, "offline"), row(left, "offline"));
  await clear();
  await hover(row(right, "offline"), "local", disabledText);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await clear();
  const notices = page.getByRole("button", { name: "关闭通知" });
  while (await notices.count()) await notices.first().click();

  await right.getByRole("tab", { name: "标签分类", exact: true }).click();
  const tag = section(right, "tag"), untagged = section(right, "__catalog_untagged__");
  const taggedCard = tag.locator("[data-asset-id]").first();
  await taggedCard.waitFor();
  await taggedCard.dispatchEvent("pointerdown");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await hover(taggedCard, "explorer", "素材即将采集到标签【测试标签】中");
  await marked(tag);
  await marked(right.locator('[data-tag-id="tag"]'));
  await checkFrame(tag);
  await page.screenshot({ path: `${output}/tag-light.png` });
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(await hint.evaluate(node => getComputedStyle(node).borderLeftStyle), "solid");
  assert.equal(await right.locator('[data-tag-id="tag"]').evaluate(node => getComputedStyle(node).outlineStyle), "solid");
  await page.emulateMedia({ forcedColors: "none" });
  await page.keyboard.press("Escape");
  await clear();
  await hover(taggedCard, "explorer", "素材即将采集到标签【测试标签】中");
  await drop(taggedCard);
  await waitForCall("local_classification_example", 1);
  assert.equal((await calls("capture_source_browser_image")).at(-1).args.skipClassification, true);
  assert.equal((await calls("local_classification_example")).at(-1).args.tagId, "tag");
  await hover(right.locator('[data-tag-id="tag"]'), "local", "素材即将采集到标签【测试标签】中");
  await marked(tag);
  await drop(right.locator('[data-tag-id="tag"]'));
  await waitForCall("local_classification_example", 2);
  assert.equal((await calls("local_classification_example")).at(-1).args.tagId, "tag");

  await hover(heading(untagged), "explorer", "素材即将采集到【全局素材库】中");
  assert.equal(await page.locator(marker).count(), 0);
  await drop(heading(untagged));
  await waitForCall("capture_source_browser_image", 3);
  assert.equal((await calls("capture_source_browser_image")).at(-1).args.skipClassification, undefined);
  assert.equal((await calls("local_classification_example")).length, 2);
  await hover(taggedCard, "explorer", "素材即将采集到标签【测试标签】中");
  await page.evaluate(() => window.store.setState({ projectRouteRevision: 1 }));
  await clear();
  assert.deepEqual(errors, []);
  console.log("PASS actual waterfall drop targets for browser and local files, empty/offline folders, explicit and untagged sections, pane isolation and cleanup.");
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
