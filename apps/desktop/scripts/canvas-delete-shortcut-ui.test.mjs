import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1615, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const [platform, shortcut] of [["MacIntel", "Meta+Backspace"], ["MacIntel", "Meta+Delete"], ["MacIntel", "Delete"], ["Win32", "Delete"]]) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(platform => Object.defineProperty(navigator, "platform", { get: () => platform }), platform);
    const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
    const stage = page.locator(".canvas-stage");
    await page.goto("http://127.0.0.1:1615/scripts/fixtures/canvas-reference/preview.html");
    await node("old").waitFor();
    await page.evaluate(() => {
      const snapshot = window.snapshot(), base = snapshot.nodes[0];
      snapshot.nodes = [
        { ...base, x: 60, y: 80 },
        { ...base, id: "prompt", kind: "prompt", assetId: null, role: null, x: 300, y: 80,
          payloadJson: JSON.stringify({ schema_version: 1, text: "生成指令", status: "succeeded" }) },
        { ...base, id: "outside", assetId: "a", x: 800, y: 600 },
      ];
      snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
      sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
    });
    await page.reload();
    await node("prompt").waitFor();
    async function select(width) {
      const rect = await stage.boundingBox();
      await page.mouse.move(rect.x + 20, rect.y + 60);
      await page.mouse.down();
      await page.mouse.move(rect.x + width, rect.y + 320, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(count => document.querySelectorAll("[data-canvas-node-id].is-selected").length === count, width === 260 ? 1 : 2);
    }
    // The same selected nodes, persistence commands and undo for both platforms.
    for (const width of [260, 620]) {
      await select(width);
      await page.keyboard.press(shortcut);
      await node("old").waitFor({ state: "detached", timeout: 5000 });
      if (width === 620) await node("prompt").waitFor({ state: "detached" });
      assert.equal(await node("outside").count(), 1);
      await page.waitForFunction(() => window.calls.some(call => call.command === "project_canvas_node_remove"));
      assert.equal(await page.evaluate(() => window.calls.some(call => /delete_asset|generation.*delete/.test(call.command))), false);
      await page.keyboard.press(platform === "MacIntel" ? "Meta+z" : "Control+z");
      await node("old").waitFor();
      await node("prompt").waitFor();
    }
    await select(620);
    for (const key of ["Backspace", "Control+Backspace", "Control+Delete", "Alt+Delete", "Shift+Delete", "Meta+Shift+Backspace", "Meta+Alt+Backspace", "Meta+Control+Backspace", ...(platform === "Win32" ? ["Meta+Backspace", "Meta+Delete"] : [])]) {
      await page.keyboard.press(key);
      assert.equal(await node("old").count(), 1, `${platform}: ignore ${key}`);
    }
    // Inputs inside the stage bubble to its handler; editing must keep the selection.
    for (const tag of ["input", "textarea", "select", "div"]) {
      await stage.evaluate((stage, tag) => {
        const field = document.createElement(tag);
        field.id = "test-editor";
        if (tag === "div") { field.contentEditable = "true"; field.innerHTML = "<span>文字</span>"; }
        stage.append(field); field.focus();
      }, tag);
      await page.keyboard.press(shortcut);
      assert.equal(await node("old").count(), 1, `${tag} editing is protected`);
      await page.locator("#test-editor").evaluate(field => field.remove());
    }
    await page.getByRole("button", { name: "放大", exact: true }).focus();
    await page.keyboard.press(shortcut);
    assert.equal(await node("old").count(), 1, "outside controls are protected");
    await stage.focus();
    for (const options of [{ repeat: true }, { isComposing: true }]) {
      await stage.dispatchEvent("keydown", { key: shortcut.split("+").at(-1), metaKey: shortcut.startsWith("Meta+"), ...options });
      assert.equal(await node("old").count(), 1);
    }
    await page.evaluate(() => {
      const dialog = document.createElement("div");
      dialog.id = "test-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
      document.body.append(dialog);
    });
    await page.keyboard.press(shortcut);
    assert.equal(await node("old").count(), 1, "modal protects the selection");
    await page.locator("#test-modal").evaluate(dialog => dialog.remove());
    await stage.click({ position: { x: 20, y: 60 } });
    await node("old").focus();
    await page.keyboard.press(shortcut);
    assert.equal(await node("old").count(), 1, "focus alone is not selection");
    await select(620);
    await page.keyboard.press(shortcut);
    await page.waitForFunction(() => ["old", "prompt"].every(id => window.snapshot().nodes.find(node => node.id === id)?.hiddenAt != null));
    await page.evaluate(() => window.save());
    await page.reload();
    await node("outside").waitFor();
    assert.equal(await node("old").count(), 0);
    assert.equal(await node("prompt").count(), 0);
    assert.equal(await page.evaluate(() => window.store.getState().assets.length), 5);
    assert.deepEqual(errors, []);
    console.log(`PASS ${platform} ${shortcut}: single/mixed selection, undo, persistence and editing protections`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
