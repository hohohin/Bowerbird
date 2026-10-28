import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");

const server = await createServer({ server: { host: "127.0.0.1", port: 1717, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 568 }, reducedMotion: "reduce" });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));

async function assertAboveLibrary(selector) {
  await page.locator(selector).evaluate(async element => {
    await Promise.all(element.closest(".canvas-board-shell").getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getTiming().iterations))
      .map(animation => animation.finished.catch(() => {})));
  });
  const point = await page.locator(selector).evaluate(element => {
    const editor = element.getBoundingClientRect();
    const library = document.querySelector(".canvas-source-panel").getBoundingClientRect();
    const left = Math.max(editor.left, library.left), right = Math.min(editor.right, library.right);
    const top = Math.max(editor.top, library.top), bottom = Math.min(editor.bottom, library.bottom);
    if (right <= left || bottom <= top) return null;
    const x = (left + right) / 2, y = (top + bottom) / 2;
    return { x, y, ownsHit: element.contains(document.elementFromPoint(x, y)) };
  });
  assert.ok(point, `${selector} must actually overlap the open library`);
  assert.equal(point.ownsHit, true, `${selector} must receive clicks above the library`);
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.locator(selector).evaluate(el => el.contains(document.activeElement)), true);
}

try {
  await page.goto("http://127.0.0.1:1717/scripts/fixtures/canvas-reference/preview.html?source-library");
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    window.store.getState().setBoardActive(true);
    window.store.getState().setCanvasLibraryOpen(true);
  });
  await page.locator(".canvas-source-panel").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector(".creation-dock.is-collapsed"));
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [900, 640]) {
      await page.setViewportSize({ width, height: 568 });
      await assertAboveLibrary(".creation-dock .ProseMirror");
      await page.keyboard.insertText("可编辑");
      assert.match(await page.locator(".creation-dock .ProseMirror").innerText(), /可编辑/);
    }
  }
  await mkdir(".tmp/composer-library-layer", { recursive: true });
  await page.screenshot({ path: ".tmp/composer-library-layer/main-dark.png" });

  await page.evaluate(() => {
    const job = { id: "continue-job", projectId: "p", threadId: "t", provider: "jimeng", sessionId: "session", conversationId: "conversation",
      running: false, streaming: "", refAssets: [], lastRatio: "1:1", lastPrompt: "原始绘画",
      turns: [{ id: 1, prompt: "原始绘画", promptRaw: "原始绘画", images: [], provider: "jimeng" }] };
    window.store.setState({ genJobs: { [job.id]: job }, genJobOrder: [job.id], activeJobId: job.id,
      activeSessionKind: "generation", genPanelOpen: true, boardOpen: false, genEditing: null });
  });
  const inspector = page.locator('[data-project-inspector="generation"]');
  await inspector.getByRole("button", { name: /^继续对话/ }).click();
  await assertAboveLibrary('[data-generation-composer="inline"] .ProseMirror');
  await page.keyboard.insertText("续聊可编辑");
  assert.equal(await page.locator('[data-generation-composer="inline"] .ProseMirror').innerText(), "续聊可编辑");
  await page.screenshot({ path: ".tmp/composer-library-layer/continuation-dark.png" });

  await page.evaluate(() => window.store.getState().setGenEditing(null));
  await inspector.locator('button[title^="重新编辑："]').click();
  await assertAboveLibrary('[data-generation-composer="floating"] .ProseMirror');
  await page.keyboard.insertText("首轮可编辑");
  assert.match(await page.locator('[data-generation-composer="floating"] .ProseMirror').innerText(), /首轮可编辑/);

  // Full-window modal dialogs must still cover the elevated composer.
  await page.evaluate(() => {
    const modal = document.createElement("div");
    modal.className = "app-modal-backdrop";
    modal.id = "layer-modal";
    document.body.append(modal);
  });
  const modalHit = await page.locator('[data-generation-composer="floating"] .ProseMirror').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const x = Math.max(20, Math.min(rect.right - 20, innerWidth - 20));
    const y = Math.max(20, Math.min(rect.bottom - 4, innerHeight - 20));
    return { id: document.elementFromPoint(x, y)?.id, rect: rect.toJSON(), x, y };
  });
  assert.equal(modalHit.id, "layer-modal", JSON.stringify(modalHit));
  assert.deepEqual(errors, []);
  console.log("PASS narrow-window main, continuation and revision composers remain clickable above the library; modal precedence preserved");
} finally {
  await browser.close();
  await server.close();
}
