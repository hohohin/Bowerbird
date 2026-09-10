import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Reuse the renderer's pinned Playwright. BOWERBIRD_TEST_CHROME can select an
// installed Chrome; otherwise the renderer's managed Chromium must be installed.
const requireRenderer = createRequire(new URL("../../html-renderer/package.json", import.meta.url));
const { chromium } = requireRenderer("playwright");
const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");

test("single Agent entry preserves access and historical runtime across UI transitions", async (t) => {
  const server = await createServer({
    root, configFile: `${root}/vite.config.ts`, server: { port: 0, host: "127.0.0.1" },
    plugins: [{ name: "agent-entry-fixture", configureServer(server) {
      server.middlewares.use("/__agent-entry", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml("/__agent-entry", `<!doctype html><html><body><div id="root"></div><script type="module" src="/scripts/fixtures/cloud-agent-entry.tsx"></script></body></html>`));
      });
    } }],
  });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.BOWERBIRD_TEST_CHROME ? { executablePath: process.env.BOWERBIRD_TEST_CHROME } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(server.resolvedUrls.local[0] + "__agent-entry");
    const agent = page.getByRole("switch", { name: "Agent", exact: true });
    const send = page.locator(".generation-send-button");
    await page.locator(".ProseMirror").fill("生成春日海报");

    await t.test("first activation and off/on submit unified DSH using cloud", async () => {
      assert.equal(await agent.getAttribute("aria-checked"), "false");
      assert.equal(await page.getByLabel("Agent Runtime").count(), 0);
      assert.equal(await page.getByLabel("Agent Skill").count(), 0);
      await agent.click();
      await agent.click();
      await agent.click();
      await send.click();
      await page.waitForFunction(() => window.agentCalls.length === 1);
      const input = await page.evaluate(() => window.agentCalls[0]);
      assert.equal(input.skillId, "bowerbird-unified-agent");
      assert.equal(input.agentRuntime, "dsh");
      assert.equal(input.imageProvider, "cloud");
      assert.equal(await page.getByText("Legacy", { exact: true }).count(), 0);
      assert.equal(await page.getByText("DSH · 自动选工具", { exact: true }).count(), 0);
    });

    await t.test("permission loss blocks sending without silently changing Agent intent", async () => {
      await page.evaluate(() => window.fixtureStore.setState({ cloudEntitlement: { ...window.fixtureEntitlement, is_test_account: false } }));
      await page.waitForFunction(() => document.querySelector(".generation-send-button").disabled);
      assert.equal(await agent.getAttribute("aria-checked"), "true");
      assert.match(await send.getAttribute("title"), /暂未开放/);
      await page.locator(".ProseMirror").press("Control+Enter");
      assert.equal(await page.evaluate(() => window.agentCalls.length), 1);
      assert.equal(await page.evaluate(() => window.directCalls.length), 0);
      await agent.click();
      assert.equal(await agent.isDisabled(), true);
      await page.evaluate(() => window.fixtureStore.setState({ cloudEntitlement: {
        ...window.fixtureEntitlement,
        policy: { ...window.fixtureEntitlement.policy, allowed_agent_skills: ["bowerbird-controlled-image-edit", "bowerbird-html-layout-render"] },
      } }));
      assert.equal(await agent.isDisabled(), true);
      await page.evaluate(() => window.fixtureStore.setState({ cloudEntitlement: window.fixtureEntitlement }));
      await agent.click();
      await send.click();
      await page.waitForFunction(() => window.agentCalls.length === 2);
    });

    await t.test("remount and historical continuation create DSH without rewriting old snapshots", async () => {
      await page.evaluate(() => {
        window.fixtureStore.setState({ cloudAgentRuns: {
          old: { runId: "old", skillId: "bowerbird-controlled-image-edit", status: "awaiting_approval", snapshot: { run: { agent_runtime: "legacy_kernel" } } },
          html: { runId: "html", skillId: "bowerbird-html-layout-render", status: "succeeded", snapshot: { run: { agent_runtime: "legacy_kernel" } } },
        } });
        window.remountComposer();
      });
      await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "false");
      await page.evaluate(() => window.fixtureStore.setState({ pendingComposerMode: "agent" }));
      await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "true");
      await page.locator(".ProseMirror").fill("继续调整海报");
      await send.click();
      await page.waitForFunction(() => window.agentCalls.length === 3);
      const state = await page.evaluate(() => ({ calls: window.agentCalls, runs: window.fixtureStore.getState().cloudAgentRuns }));
      assert.ok(state.calls.every((call) => call.skillId === "bowerbird-unified-agent" && call.agentRuntime === "dsh"));
      assert.equal(state.runs.old.snapshot.run.agent_runtime, "legacy_kernel");
      assert.equal(state.runs.html.skillId, "bowerbird-html-layout-render");
    });

    await t.test("account change during async creation cannot use stale authority", async () => {
      await page.evaluate(() => { window.pauseThread = true; });
      await send.click();
      await page.waitForFunction(() => typeof window.releaseThread === "function");
      await page.evaluate(() => {
        window.fixtureStore.setState({ cloudAuth: { logged_in: true, cloud_available: true, user_id: "another-user" } });
        window.releaseThread();
      });
      await page.waitForFunction(() => !document.querySelector(".generation-send-button").textContent.includes("正在"));
      assert.equal(await page.evaluate(() => window.agentCalls.length), 3);
      assert.equal(await page.evaluate(() => window.directCalls.length), 0);
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
