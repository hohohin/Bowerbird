import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");

// 后端确认启动后退出；提交中／拒绝时保留；旧任务完成不打断新的组稿。
const server = await createServer({ server: { host: "127.0.0.1", port: 1594, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1594/scripts/fixtures/canvas-reference/preview.html");
  await page.waitForFunction(() => document.querySelector('.canvas-workspace[aria-busy="false"]'));
  const dock = page.locator('.creation-dock');
  await dock.waitFor();
  const editor = dock.locator(".ProseMirror");

  await page.evaluate(() => {
    // fixture 未覆盖 project_thread_create（resolveCreativeThread 首发新建线程）。
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "codex_create_image") {
        if (window.rejectGeneration) throw new Error("模拟提交被拒绝");
        return new Promise(resolve => { window.finishGeneration = resolve; });
      }
      if (command === "project_thread_create") {
        return { id: args.value.id, projectId: args.value.projectId, title: args.value.title,
          archivedAt: null, createdAt: 1, updatedAt: 1 };
      }
      return original(command, args);
    };
    window.store.setState({
      activeGenProvider: "jimeng",
      dreaminaHealth: { ok: true },
      cloudEntitlement: { plan: "pro", policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } },
    });
  });

  // 尚未收到后端启动确认时不退出。
  await editor.click();
  await editor.fill("第一轮提示词");
  await page.waitForFunction(() => window.store.getState().boardOpen === true);
  await dock.getByRole("button", { name: "生成图像", exact: true }).click();
  await page.waitForFunction(() => Object.keys(window.store.getState().genJobs).length === 1);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true,
    "提交中应保持创作模式");

  // 启动成功即可退出，无须等待生成结果。
  await page.evaluate(() => {
    const jobId = window.store.getState().activeJobId;
    window.store.getState().applyGenChunk({ kind: "started", job_id: jobId });
  });
  await page.waitForFunction(() => window.store.getState().boardOpen === false);
  assert.equal(await page.evaluate(() => {
    const s = window.store.getState();
    return s.genJobs[s.activeJobId].running && s.genJobs[s.activeJobId].turns[0].images.length === 0;
  }), true, "退出时任务仍在后台生成");
  assert.equal(await dock.evaluate(el => el.classList.contains("is-collapsed")), true,
    "退出创作模式后对话框应收起");

  // 用户开始组新稿后，上一任务成功不能再退出创作模式。
  await editor.click();
  await editor.fill("第二轮提示词");
  await page.waitForFunction(() => window.store.getState().boardOpen === true);
  await page.evaluate(() => {
    const jobId = window.store.getState().activeJobId;
    window.store.getState().applyGenChunk({ kind: "done", job_id: jobId, images: ["out.png"], session_id: "s1", provider: "jimeng" });
    window.finishGeneration(null);
  });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true,
    "旧任务生成成功不能打断新的创作");

  // 提交被拒绝时保留创作模式和草稿。
  await page.evaluate(() => { window.rejectGeneration = true; });
  await dock.getByRole("button", { name: "生成图像", exact: true }).click();
  await page.waitForFunction(() => Object.keys(window.store.getState().genJobs).length === 2);
  await page.waitForFunction(() => {
    const s = window.store.getState();
    return !s.genJobs[s.activeJobId].running;
  });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true,
    "提交失败不应退出创作模式");
  assert.equal(await editor.innerText(), "第二轮提示词");

  assert.deepEqual(errors, []);
  console.log("PASS: startup exits creation mode; pending/rejected submissions retain drafts; completion leaves new composition active");
} finally {
  await browser.close();
  await server.close();
}
