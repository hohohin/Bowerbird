import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// 生成图像按钮 → 会话卡片生成成功时自动退出创作模式：普通生成提交后创作模式保持
// 激活（生成期间可继续组稿），job 成功结算（末轮有产出图）才退出；失败结算保持创作
// 模式。终端型 / Cloud Agent 路径仍完成即退出（不在本测试范围）。
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

  // 首次发送：提交成功后创作模式保持激活（不立即退出）。
  await editor.click();
  await editor.fill("第一轮提示词");
  await page.waitForFunction(() => window.store.getState().boardOpen === true);
  await dock.getByRole("button", { name: "生成图像", exact: true }).click();
  await page.waitForFunction(() => Object.keys(window.store.getState().genJobs).length === 1);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true,
    "提交被接受后创作模式应保持激活，等会话卡片生成成功再退出");

  // 成功结算（done + 产出图）→ 自动退出创作模式，对话框收起。
  await page.evaluate(() => {
    const jobId = window.store.getState().activeJobId;
    window.store.getState().applyGenChunk({ kind: "done", job_id: jobId, images: ["out.png"], session_id: "s1", provider: "jimeng" });
  });
  await page.waitForFunction(() => window.store.getState().boardOpen === false);
  assert.equal(await dock.evaluate(el => el.classList.contains("is-collapsed")), true,
    "退出创作模式后对话框应收起");

  // 失败路径：重新激活创作模式再发一轮，error 结算不退出（保持组稿/重试）。
  await editor.click();
  await editor.fill("第二轮提示词");
  await page.waitForFunction(() => window.store.getState().boardOpen === true);
  await dock.getByRole("button", { name: "生成图像", exact: true }).click();
  await page.waitForFunction(() => Object.keys(window.store.getState().genJobs).length === 2);
  await page.evaluate(() => {
    const jobId = window.store.getState().activeJobId;
    window.store.getState().applyGenChunk({ kind: "error", job_id: jobId, message: "模拟引擎失败" });
  });
  await page.waitForFunction(() => {
    const s = window.store.getState();
    return !s.genJobs[s.activeJobId].running;
  });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true,
    "生成失败的会话卡片不应退出创作模式");

  assert.deepEqual(errors, []);
  console.log("PASS: ordinary generation keeps creation mode active until the session card succeeds");
} finally {
  await browser.close();
  await server.close();
}
