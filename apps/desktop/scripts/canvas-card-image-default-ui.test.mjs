import assert from "node:assert/strict";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";
import { createServer } from "vite";
import { placeWorkflowCard } from "./fixtures/canvas-reference/place-card.mjs";

const server = await createServer({ cacheDir: ".tmp/card-image-default-vite", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const target = "dreamina-web55";
const base = server.resolvedUrls.local[0];
try {
  for (const action of ["收藏", "设为默认"]) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + "scripts/fixtures/canvas-reference/preview.html");
    await page.locator("[data-canvas-node-id=old]").waitFor();
    await page.evaluate(() => localStorage.setItem("bowerbird.defaultProvider", "dreamina-web50pro"));
    async function restart() {
      await page.reload();
      await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
      await page.evaluate(() => window.store.setState({
        cloudAuth: { logged_in: true, cloud_available: true },
        cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 0, sub: 100, topup: 0 } },
        dreaminaHealth: { ok: true }, codexHealth: { ok: true },
      }));
    }
    async function expectLatest(count, provider) {
      await page.waitForFunction(({ count, provider }) => {
        const nodes = JSON.parse(sessionStorage.getItem("workflow-p"))?.document.nodes;
        return nodes?.length === count && nodes.at(-1).provider === provider;
      }, { count, provider });
    }
    await restart();
    await placeWorkflowCard(page, "新增生成卡片");
    const first = page.locator(".workflow-card.is-generation").first();
    await first.locator("header").hover();
    await first.locator(".model-select-trigger").click();
    const menu = page.getByRole("dialog", { name: "图像模型", exact: true });
    await menu.locator('[data-source="personal"] [data-model-group="即梦"]').click();
    await menu.getByRole("button", { name: action + "：Seedream 5.5", exact: true }).click();
    await restart();
    await placeWorkflowCard(page, "新增生成卡片");
    await expectLatest(2, target);

    const stage = page.locator("[data-canvas-stage]");
    const rect = await stage.boundingBox();
    const x = rect.x + rect.width - 140, y = rect.y + 135;
    await page.mouse.dblclick(x, y);
    await page.getByRole("menu", { name: "新建卡片" }).getByRole("menuitem", { name: "图片生成" }).click();
    await expectLatest(3, target);

    await first.locator("header").hover();
    await first.getByRole("button", { name: "视频", exact: true }).click();
    await first.getByRole("button", { name: "图片", exact: true }).click();
    await page.waitForFunction(key => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].provider === key, target);

    const material = page.locator('[data-canvas-node-id="old"]');
    await material.hover();
    const from = await page.locator('[data-workflow-material="old"] [data-canvas-connect-side="output"]').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x - 100, rect.y + rect.height - 130, { steps: 12 });
    await page.mouse.up();
    await page.getByRole("menu", { name: "添加下游" }).getByRole("menuitem", { name: "图片生成" }).click();
    await expectLatest(4, target);

    await first.locator("header").hover();
    await first.locator(".model-select-trigger").click();
    await menu.locator('[data-model-key="codex"]').click();
    assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), "codex");
    await placeWorkflowCard(page, "新增生成卡片");
    await expectLatest(5, action === "收藏" ? "codex" : target);

    await page.goto(base + "scripts/fixtures/local-chat/preview.html");
    await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
    await placeWorkflowCard(page, "新增 Agent 卡片");
    const agent = page.locator('.workflow-card.is-agent');
    await agent.getByRole("textbox", { name: "Agent 要求" }).fill("创建一张图片生成卡");
    await agent.getByRole("button", { name: "运行此卡片", exact: true }).click();
    await page.waitForFunction(key => window.localChatFixture.inspect().calls.some(call =>
      call.command === "local_chat_send" && call.args.input.cardDefaults?.provider === key), target);
    assert.deepEqual(errors, []);
    await page.close();
    console.log("PASS", action, "Seedream 5.5 persists across restart and all five card entry paths");
  }
} finally {
  await browser.close();
  await server.close();
}
