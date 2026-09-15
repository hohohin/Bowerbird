import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({
  optimizeDeps: { entries: ["scripts/fixtures/project-order/preview.html"] },
  server: { host: "127.0.0.1", port: 1441, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const badges = page.locator('.app-sidebar-project-badge[aria-label^="切换到项目"]');
async function order() { return page.evaluate(() => window.fixtureStore.getState().projects.map(p => p.id)); }
async function layout() { return badges.evaluateAll(nodes => nodes.map(node => ({ label: node.title, y: node.getBoundingClientRect().y }))); }
async function check(ids, active) {
  assert.deepEqual(await order(), ids);
  const names = await page.evaluate(() => window.fixtureStore.getState().projects.map(p => p.name));
  assert.deepEqual(await badges.evaluateAll(nodes => nodes.map(node => node.title)), names);
  assert.deepEqual(await page.locator("#expanded .project-name").allTextContents(), names);
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeProjectId), active);
  if (active) {
    const name = await page.evaluate(id => window.fixtureStore.getState().projects.find(p => p.id === id).name, active);
    assert.equal(await page.locator(".app-sidebar-project-badge.is-active").getAttribute("title"), name);
    assert.equal(await page.locator("#expanded .is-active .project-name").innerText(), name);
  }
}
try {
  await page.goto("http://127.0.0.1:1441/scripts/fixtures/project-order/preview.html");
  await badges.first().waitFor();
  await check(["a", "b", "c"], null);
  const before = await layout();
  const positions = [{ active: null, items: before }];
  for (const [id, name] of [["c", "森林"], ["b", "湖泊"], ["a", "山丘"], ["c", "森林"]]) {
    await page.getByRole("button", { name: `切换到项目 ${name}`, exact: true }).click();
    await page.waitForFunction(id => window.fixtureStore.getState().activeProjectId === id && !window.fixtureStore.getState().projectRoutePending, id);
    await page.evaluate(() => window.fixtureStore.getState().reloadProjects());
    await check(["a", "b", "c"], id);
    assert.deepEqual(await layout(), before, "click + reload must not move project badges");
    positions.push({ active: id, items: await layout() });
  }
  assert.ok(await page.evaluate(() => window.rows().find(p => p.id === "c").last_opened_at > 100));
  await page.reload();
  await badges.first().waitFor();
  await check(["a", "b", "c"], null);
  await page.evaluate(() => window.rename("c", "改名森林"));
  await check(["a", "b", "c"], null);
  await page.evaluate(async () => { window.add(); await window.fixtureStore.getState().reloadProjects(); });
  await check(["d", "a", "b", "c"], null);
  await page.evaluate(() => window.fixtureStore.getState().deleteProjectCanvas("b"));
  await check(["d", "a", "c"], null);
  await page.evaluate(() => window.fixtureStore.getState().enterProject("a"));
  for (const flag of ["failSwitch", "failFlush"]) {
    const failure = await page.evaluate(async flag => {
      window[flag] = true;
      try { await window.fixtureStore.getState().enterProject("c"); } catch (e) { return String(e); }
      finally { window[flag] = false; }
    }, flag);
    assert.match(failure, /synthetic/);
    await check(["d", "a", "c"], "a");
    assert.equal(await page.evaluate(() => window.backendActive), "a");
  }
  await page.evaluate(async () => { window.failList = true; await window.fixtureStore.getState().reloadProjects(); window.failList = false; });
  await check(["d", "a", "c"], "a");
  // An in-flight list snapshot omits c while a newer route enters it. Keep c in
  // its original slot, then reconcile a fresh response without dropping selection.
  await page.evaluate(() => {
    const row = window.rows().find(p => p.id === "c");
    window.rows().splice(window.rows().indexOf(row), 1);
    window.deferList = true;
    window.pendingReload = window.fixtureStore.getState().reloadProjects();
    window.omitted = row;
  });
  await page.waitForFunction(() => !!window.releaseList);
  await page.evaluate(async () => {
    window.rows().push(window.omitted);
    await window.fixtureStore.getState().enterProject("c");
    window.releaseList();
    await window.pendingReload;
    await window.fixtureStore.getState().reloadProjects();
  });
  await check(["d", "a", "c"], "c");
  // Queued reloads across consecutive routes use the current ordering at commit.
  await page.evaluate(async () => {
    await Promise.all([
      window.fixtureStore.getState().enterProject("a"),
      window.fixtureStore.getState().reloadProjects(),
      window.fixtureStore.getState().enterProject("d"),
      window.fixtureStore.getState().reloadProjects(),
    ]);
  });
  await check(["d", "a", "c"], "d");
  await page.evaluate(() => window.fixtureStore.getState().deleteProjectCanvas("d"));
  await check(["a", "c"], null);
  const provisionalId = await page.evaluate(() => window.fixtureStore.getState().beginProvisionalProject());
  await page.evaluate(() => window.fixtureStore.getState().reloadProjects());
  await check([provisionalId, "a", "c"], provisionalId);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("bowerbird.projectOrder"))), ["a", "c"]);
  await page.evaluate(() => window.fixtureStore.getState().exitProject());
  await check(["a", "c"], null);
  await mkdir(".tmp", { recursive: true });
  await writeFile(".tmp/project-order-positions.json", JSON.stringify(positions, null, 2));
  await page.screenshot({ path: ".tmp/project-order-verified.png" });
  assert.deepEqual(errors, []);
  console.log("PASS project order: real sidebar/store, positions, metadata, restart, rename, add/delete, provisional, failures and async routes");
} finally {
  await browser.close();
  await server.close();
}
