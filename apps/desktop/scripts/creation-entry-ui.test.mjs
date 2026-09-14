import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1590, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const assertBrowsing = async () => {
  await page.locator('[data-canvas-stage]').waitFor();
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), false);
  assert.equal(await page.locator('.canvas-stage.is-creation-mode').count(), 0);
  assert.equal(await page.getByRole("button", { name: "退出创作模式", exact: true }).count(), 0);
};
try {
  await page.goto("http://127.0.0.1:1590/scripts/fixtures/canvas-reference/preview.html?explorer");
  await page.evaluate(() => window.setExploring(false));
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  await page.evaluate(async () => {
    window.store.getState().setBoardActive(true);
    await window.store.getState().enterProject("q");
  });
  await assertBrowsing();
  const editor = page.locator('[data-onboarding-composer] .ProseMirror');
  await editor.click();
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  await page.getByRole("button", { name: "退出创作模式", exact: true }).click();
  await assertBrowsing();
  await editor.click();
  await page.evaluate(() => window.store.getState().beginProvisionalProject());
  await assertBrowsing();
  await editor.click();
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  await page.keyboard.press("Escape");
  await assertBrowsing();

  // Reopening an existing project restores its draft without activating the composer.
  await page.evaluate(async () => {
    const saved = window.snapshot();
    saved.canvas.draftJson = JSON.stringify({ schema_version: 1, composer: {
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "保留已有草稿" }] }] }, refs: [],
    } });
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === "project_canvas_get" && args.projectId === "p"
      ? Promise.resolve(saved) : invoke(command, args);
    await window.store.getState().enterProject("p");
  });
  await page.getByText("保留已有草稿", { exact: true }).waitFor();
  await assertBrowsing();

  // Isolate seeded composer mounts, including asynchronous missing-asset hydration.
  await page.route("**/creation-entry-seed", route => route.fulfill({ contentType: "text/html", body: '<div id="test"></div>' }));
  for (const missing of [false, true]) {
    await page.goto("http://127.0.0.1:1590/creation-entry-seed");
    await page.evaluate(async missing => {
      window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 1 };
      const [{ useStore }, { api }, { default: React }, { default: { createRoot } }, { CreativeComposer }] = await Promise.all([
        import("/src/store.ts"), import("/src/lib/api.ts"), import("/node_modules/.vite/deps/react.js"),
        import("/node_modules/.vite/deps/react-dom_client.js"), import("/src/components/CreativeComposer.tsx"),
      ]);
      await import("/src/styles.css");
      window.store = useStore;
      const asset = { id: "seed", name: "预填参考", sections: [], store_path: null };
      api.getPromptedAsset = async () => { await new Promise(resolve => setTimeout(resolve, 50)); return asset; };
      useStore.setState({ boardOpen: false, activeProjectId: "seed-project", assets: missing ? [] : [asset], promptedAssets: missing ? [] : [asset], settings: {} });
      createRoot(document.getElementById("test")).render(React.createElement(CreativeComposer, {
        projectId: "seed-project", draftJson: "{}", initialAssetIds: ["seed"], onDraftChange: () => {},
        resolveCreativeThread: async () => { throw new Error("generation must not run"); },
      }));
    }, missing);
    await page.locator('[data-onboarding-composer] [data-asset-id="seed"]').waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().boardOpen), false, `seed focus (${missing ? "async" : "loaded"})`);
    assert.equal(await page.locator('[data-onboarding-composer]').evaluate(el => el.contains(document.activeElement)), false);
    await page.locator('[data-onboarding-composer]').click();
    assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  }
  assert.deepEqual(errors, []);
  console.log("PASS: project entry/switch/new default to browsing, explicit click activates, exit/Escape works, saved draft restores, loaded and async references seed without focus");
} finally {
  await browser.close();
  await server.close();
}
