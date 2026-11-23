import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ cacheDir: ".tmp/library-project-scope/vite", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" });
page.setDefaultTimeout(10000);
const errors = [];
await page.addInitScript(() => { window.distinctProjects = true; window.total = 4; });
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const side = page.getByRole("complementary", { name: "素材库导航", exact: true });
const row = name => side.getByRole("button", { name, exact: true });
const assets = (id, section = "all") => page.locator(`[data-catalog-section="${section}"] [data-asset-id^="${id}:"]`);
try {
  const fixture = `${server.resolvedUrls.local[0]}scripts/fixtures/catalog-paging/preview.html?navigation`;
  await page.goto(fixture + "&home");
  await row("项目").click();
  await assets("p", "p").first().waitFor();
  await assets("q", "q").first().waitFor();
  for (const width of [1000, 600, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const project = await row("项目A").boundingBox();
    assert.ok(project.x >= 0 && project.x + project.width <= width);
  }
  await row("项目B").click();
  await assets("q").first().waitFor();
  assert.equal(await assets("p").count(), 0);
  await page.reload();
  await assets("q").first().waitFor();
  await row("标签模式").click();
  await assets("global", "first").first().waitFor();
  await row("层级模式").click();
  await assets("q").first().waitFor();
  await page.evaluate(() => window.store.setState({ projects: window.store.getState().projects.filter(project => project.id !== "q") }));
  await assets("p", "p").first().waitFor();
  assert.equal(await row("项目").getAttribute("aria-current"), "true");
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(fixture);
  await assets("p").first().waitFor();
  await row("项目B").click();
  const member = assets("q").first();
  await member.waitFor();
  const memberId = await member.getAttribute("data-asset-id");
  await member.click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除", exact: true }).hover();
  await page.getByRole("menuitem", { name: "移出当前项目", exact: true }).click();
  await page.waitForFunction(() => window.requests.some(request => request.command === "remove_assets_from_project"));
  const request = await page.evaluate(() => window.requests.findLast(request => request.command === "remove_assets_from_project"));
  assert.equal(request.args.projectId, "q");
  assert.deepEqual(request.args.assetIds, [memberId]);
  assert.equal(await page.evaluate(() => window.store.getState().activeProjectId), "p");
  assert.deepEqual(errors, []);
  console.log("PASS project overview, single-project scope, global tags, and scoped removal without routing");
} finally {
  await browser.close(); await server.close();
}
