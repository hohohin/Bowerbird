import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 1574, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.setDefaultTimeout(8000);
const errors = []; page.on("pageerror", e => errors.push(e.message));
const imports = () => page.evaluate(() => window.calls.filter(c => c.command === "import_image_bytes"));
async function drag(selector, names = ["test.png"], text = "") {
  await page.locator(selector).first().evaluate((element, { names, text }) => {
    window.files = new DataTransfer();
    for (const name of names) window.files.items.add(new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }));
    if (text) window.files.setData("text/plain", text);
    for (const type of ["dragenter", "dragover"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.files }));
  }, { names, text });
}
async function drop(selector) {
  await page.locator(selector).first().evaluate(element => element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.files })));
  await page.locator("[data-file-drop-overlay]").waitFor({ state: "hidden" });
}
try {
  await page.goto("http://127.0.0.1:1574/scripts/fixtures/project-drop/preview.html");
  await page.locator('[data-asset-id="one"]').waitFor();
  const card = '.library-project-folder[data-project-drop-id="p"]';
  await drag(card);
  await page.getByText("松开导入到「目标项目」", { exact: true }).waitFor();
  await drop(card);
  await page.waitForFunction(() => window.store.getState().assets.some(a => a.name === "test.png"));
  assert.equal((await imports()).length, 1);
  assert.equal((await imports())[0].args.projectId, "p");
  assert.equal(await page.locator(card).getAttribute("aria-expanded"), "false");
  // Header, editable controls, side rail and window whitespace share the fallback.
  for (const selector of ["[data-test-topbar]", "input", ".app-sidebar", "body"]) {
    const count = (await imports()).length;
    await drag(selector, [`outside-${count}.png`]);
    await page.getByText("松开导入到素材库", { exact: true }).waitFor();
    await drop(selector);
    await page.waitForFunction(count => window.calls.filter(c => c.command === "import_image_bytes").length === count + 1, count);
    assert.equal((await imports()).at(-1).args.projectId, null);
  }
  await page.locator(card).click();
  const nested = '.library-project-frame[data-project-drop-id="p"] [data-asset-id="owned"]';
  await drag(nested, ["nested.png"]); await drop(nested);
  await page.waitForFunction(() => window.store.getState().assets.some(a => a.name === "nested.png"));
  assert.equal((await imports()).at(-1).args.projectId, "p");
  // A route switch while FileReader/IPC is pending must not retarget the batch.
  await page.evaluate(() => { window.store.setState({ activeProjectId: "p" }); window.holdImport = true; });
  await drag("[data-test-topbar]", ["frozen.png"]); await drop("[data-test-topbar]");
  await page.waitForFunction(() => window.releaseImport);
  await page.evaluate(() => { window.store.setState({ activeProjectId: "q" }); window.holdImport = false; window.releaseImport(); });
  await page.waitForFunction(() => window.store.getState().assets.some(a => a.name === "frozen.png"));
  assert.equal((await imports()).at(-1).args.projectId, "p");
  await page.evaluate(() => window.store.setState({ activeProjectId: null }));
  await drag("[data-test-topbar]", ["bad.png", "good.png"]); await drop("[data-test-topbar]");
  await page.getByText("bad.png：模拟图片损坏", { exact: true }).waitFor();
  await page.waitForFunction(() => window.store.getState().assets.some(a => a.name === "good.png"));
  await drag("[data-test-topbar]");
  await page.evaluate(() => window.dispatchEvent(new DragEvent("dragleave", { relatedTarget: null })));
  await page.locator("[data-file-drop-overlay]").waitFor({ state: "hidden" });
  // Internal moves and plain text never trigger file ingestion or the overlay.
  const before = (await imports()).length;
  await page.locator('[data-asset-id="one"]').first().dragTo(page.locator('.sidebar-nav-item[data-project-drop-id="q"]'));
  assert.equal((await imports()).length, before);
  await page.locator("[data-test-topbar]").evaluate(element => {
    const dt = new DataTransfer(); dt.setData("text/plain", "plain text");
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  assert.equal((await imports()).length, before);
  assert.equal(await page.locator("[data-file-drop-overlay]").count(), 0);
  // A file plus ordinary text still imports, even over an open explorer target.
  await page.evaluate(() => {
    const workspace = document.createElement("div"); workspace.className = "explore-workspace is-open";
    const target = document.createElement("div"); target.className = "explore-main";
    workspace.append(target); document.body.append(workspace);
  });
  await drag(".explore-main", ["mixed-local.png"], "ordinary file description");
  assert.equal(await page.locator("[data-file-drop-overlay]").count(), 0);
  await drop(".explore-main");
  await page.waitForFunction(() => window.store.getState().assets.some(a => a.name === "mixed-local.png"));
  assert.equal((await imports()).length, before + 1);
  await page.evaluate(() => document.querySelector('.explore-workspace').remove());
  // Collection portals retain their own destination and import exactly once.
  await page.evaluate(async () => {
    const [{ default: React }, { default: { createRoot } }, { CollectionPanel }] = await Promise.all([
      import("/node_modules/.vite/deps/react.js"), import("/node_modules/.vite/deps/react-dom_client.js"),
      import("/src/components/CollectionPanel.tsx"),
    ]);
    const host = document.createElement("div"); document.body.appendChild(host);
    createRoot(host).render(React.createElement(CollectionPanel, {
      folder: { id: "collection", name: "测试集合", kind: "collection" }, onClose: () => {},
    }));
  });
  await page.locator(".collection-panel .app-modal").waitFor();
  await drag(".collection-panel .app-modal", ["collection.png"]);
  assert.equal(await page.locator("[data-file-drop-overlay]").count(), 0);
  await drop(".collection-panel .app-modal");
  await page.waitForFunction(() => window.calls.some(c => c.command === "move_assets_to_folder"));
  assert.equal((await imports()).length, before + 2);
  assert.equal((await imports()).at(-1).args.projectId, null);
  assert.equal(await page.evaluate(() => window.calls.find(c => c.command === "move_assets_to_folder").args.folderId), "collection");
  assert.deepEqual(errors, []);
  console.log("PASS: window-wide file import, collapsed/expanded project targets, nested controls, frozen destination, batch failure isolation and internal-drag preservation.");
} finally { if (errors.length) console.error(errors); await browser.close(); await server.close(); }
