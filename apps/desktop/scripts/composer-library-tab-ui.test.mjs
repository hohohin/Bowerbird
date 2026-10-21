import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 1705, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1705/scripts/fixtures/canvas-reference/preview.html?source-library");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const assets = window.store.getState().assets;
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "material_catalog") return { tags: [], collections: [], prompts: [], tag_asset_ids: {} };
      if (command === "material_catalog_assets") return assets;
      if (command === "external_file_media") return args.path;
      return original(command, args);
    };
    window.emitAssetsChanged();
  });
  const editor = page.locator('.creation-dock .ProseMirror');
  await editor.fill("前后");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => window.store.getState().canvasLibraryOpen && document.activeElement?.classList.contains("canvas-source-panel"));
  assert.equal(await editor.innerText(), "前后");
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  await page.locator('.categorized-library [data-asset-id="a"]').click();
  await editor.locator('[data-asset-id="a"]').waitFor();
  assert.equal(await editor.evaluate(el => el.textContent.startsWith("前") && el.textContent.endsWith("后")), true, "library pick retains the insertion caret");
  await page.getByRole("button", { name: "关闭素材库", exact: true }).click();

  // Modified Tab and IME events retain editor behavior; menus retain their own navigation.
  for (const options of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await editor.focus();
    const prevented = await editor.evaluate((el, options) => {
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...options });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, options);
    assert.equal(prevented, false);
    assert.equal(await page.evaluate(() => window.store.getState().canvasLibraryOpen), false);
  }
  await page.evaluate(() => { const menu = document.createElement("div"); menu.id = "test-menu"; menu.setAttribute("role", "menu"); document.body.append(menu); });
  assert.equal(await editor.evaluate(el => !el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))), false);
  await page.evaluate(() => document.getElementById("test-menu").remove());

  // Non-composer inputs keep native Tab even inside the same workspace.
  assert.equal(await page.evaluate(() => {
    const input = document.createElement("input"); document.querySelector(".canvas-workspace").append(input);
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(event); input.remove(); return event.defaultPrevented;
  }), false);

  // The continuation composer uses the same shortcut.
  await page.evaluate(() => {
    const job = { id: "continue-job", projectId: "p", threadId: "t", provider: "jimeng", sessionId: "session", conversationId: "conversation",
      running: false, streaming: "", refAssets: [], lastRatio: "1:1", lastPrompt: "原始绘画",
      turns: [{ id: 1, prompt: "原始绘画", images: [], provider: "jimeng" }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id,
      activeSessionKind: "generation", genPanelOpen: true, boardOpen: false, genEditing: null });
  });
  await page.locator('[data-project-inspector="generation"]').getByRole("button", { name: /^继续对话/ }).click();
  const inline = page.locator('[data-generation-composer="inline"] .ProseMirror');
  await inline.fill("续写草稿");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => window.store.getState().canvasLibraryOpen && document.activeElement?.classList.contains("canvas-source-panel"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.store.getState().canvasLibraryOpen);
  assert.equal(await inline.innerText(), "续写草稿");
  assert.deepEqual(errors, []);
  console.log("PASS composer Tab opens/focuses library, preserves caret and drafts, supports continuation and protects IME/modifiers/menus/other inputs");
} finally {
  await browser.close();
  await server.close();
}
