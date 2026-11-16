import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// Delay only the native replies. The workspace, store and workflow are the production components.
const server = await createServer({
  plugins: [{ name: "workflow-readiness-fixture", transform(source, id) {
    if (id.endsWith("/fixtures/canvas-reference/preview.tsx")) {
      return source.replace("w.calls.push({ command, args });", `w.calls.push({ command, args });
        const captured = command === "canvas_workflow_get" && sessionStorage.getItem("workflow-" + args.projectId);
        await w.delayReply?.(command, args);
        if (captured) return JSON.parse(captured);`);
    }
  } }],
  cacheDir: ".tmp/workflow-readiness-vite",
  server: { host: "127.0.0.1", port: 16465, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/canvas-reference/preview.html`;
const errors = [];
async function fixture(mode) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(mode => {
    const reads = {};
    window.releaseWorkflow = {};
    window.delayReply = async (command, { projectId, assetIds } = {}) => {
      if (command === "get_assets_by_ids" && assetIds?.[0] === "archived-h3-result") {
        if (mode === "history") await new Promise(resolve => { window.releaseWorkflow.history = resolve; });
        if (mode === "history-failure" && !reads.history) { reads.history = 1; throw Error("fixture H3 recovery read failure"); }
      }
      if (!["project_canvas_get", "canvas_workflow_get"].includes(command)) return;
      const key = command + ":" + projectId;
      reads[key] = (reads[key] ?? 0) + 1;
      if (mode === "window" && projectId === "p" && (command === "project_canvas_get" && reads[key] === 1
        || command === "canvas_workflow_get" && reads[key] <= 2)) {
        await new Promise(resolve => { window.releaseWorkflow[command + reads[key]] = resolve; });
      }
      if (mode === "duplicate" && command === "project_canvas_get" && reads[key] === 2
        || mode === "switch" && command === "canvas_workflow_get" && reads[key] <= 2
        || mode === "cache" && key === "canvas_workflow_get:p" && reads[key] === 2) {
        await new Promise(resolve => { window.releaseWorkflow[mode === "switch" ? projectId + reads[key] : projectId] = resolve; });
      }
      if (mode === "failure" && command === "canvas_workflow_get" && reads[key] === 1) throw Error("fixture workflow read failure");
      if (mode === "cache" && key === "canvas_workflow_get:p" && reads[key] === 2) throw Error("fixture cache refresh failure");
    };
    for (const project of ["p", "q"]) {
      const nodes = ["instruction", "generation", "agent", "comfy-video"].map((kind, i) => ({
        id: project + "-" + kind, kind, x: 80 + i * 100, y: 100, action: "describe", skill: "image-edit",
        prompt: project + " first prompt", ratio: null, provider: "codex", inputs: {}, outputs: {}, outputPorts: [], trigger: false,
      }));
      let run = null;
      if (mode === "history" || mode === "history-failure") {
        const video = nodes.find(node => node.kind === "comfy-video");
        video.outputs = { image: { type: "image", assetIds: ["archived-h3-result"] } };
        run = { id: "archived-run", startId: video.id, threadId: "t", order: [video.id], status: "done",
          steps: { [video.id]: { status: "done", jobId: "original-job" } } };
      }
      sessionStorage.setItem("workflow-" + project, JSON.stringify({ revision: 0, document: { schema_version: 1, nodes, run } }));
    }
  }, mode);
  await page.goto(url);
  return page;
}
const cards = page => page.locator("[data-workflow-card]");
const create = page => page.getByRole("button", { name: "新增生成卡片", exact: true });
async function switchTo(page, id) {
  await page.evaluate(async id => {
    const { useStore } = await import("/src/store.ts");
    const state = useStore.getState();
    useStore.setState({ activeProjectId: id, projectRouteRevision: state.projectRouteRevision + 1,
      projects: state.projects.some(project => project.id === id) ? state.projects : [...state.projects, { ...state.projects[0], id, name: id }] });
  }, id);
}
async function ready(page, id) {
  await page.locator(`[data-workflow-card="${id}-instruction"]`).waitFor();
  assert.equal(await cards(page).count(), 4);
  assert.equal(await page.evaluate(async id => (await import("/src/lib/canvasWorkflowRuntime.ts")).canvasWorkflowController(id).ready, id), true);
}
try {
  const cold = await fixture("duplicate");
  await cold.waitForFunction(async () => window.releaseWorkflow.p || (await import("/src/lib/canvasWorkflowRuntime.ts")).canvasWorkflowController("p").ready);
  if (await cold.evaluate(() => !!window.releaseWorkflow.p)) {
    await cold.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      useStore.setState({ activeGenProvider: "dreamina" });
    });
    await cold.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const prompt = cold.getByRole("textbox", { name: "反推要求" });
    if (await prompt.count()) {
      await prompt.fill("premature edit", { force: true });
      console.log("cold repro", { visible: await prompt.isVisible(), editable: await prompt.isEditable(), screen: (await cold.locator("body").innerText()).split("\n").filter(line => line.includes("未载入")) });
    }
    assert.equal(await cards(cold).count(), 0, "partially reconciled cards must not expose prompt, dropdown or run controls");
    await cold.evaluate(() => window.releaseWorkflow.p());
  }
  await ready(cold, "p");
  assert.equal(await cold.evaluate(() => window.calls.filter(call => call.command === "project_canvas_get").length), 1);
  await cold.close();

  const history = await fixture("history");
  await history.waitForFunction(() => !!window.releaseWorkflow.history);
  await history.getByText("正在加载工作流…", { exact: true }).waitFor();
  assert.equal(await history.evaluate(async () => (await import("/src/lib/canvasWorkflowRuntime.ts")).canvasWorkflowController("p").document.nodes.length), 4);
  assert.equal(await cards(history).count(), 0, "editor waits for recovery of historical H3 results");
  await history.getByRole("button", { name: "工具箱", exact: true }).click();
  assert.equal(await history.getByRole("menuitem", { name: /本地 H3 视频/ }).isDisabled(), true);
  assert.equal(await history.getByRole("menuitem", { name: /视频复刻工具/ }).isEnabled(), true);
  await history.keyboard.press("Escape");
  await history.evaluate(() => window.releaseWorkflow.history());
  await ready(history, "p");
  await history.close();

  const cached = await fixture("cache");
  await ready(cached, "p");
  await switchTo(cached, "q");
  await ready(cached, "q");
  await cached.evaluate(() => {
    const snapshot = JSON.parse(sessionStorage.getItem("workflow-p"));
    snapshot.revision++;
    snapshot.document.nodes[0] = { ...snapshot.document.nodes[0], id: "p-new", prompt: "changed while away" };
    sessionStorage.setItem("workflow-p", JSON.stringify(snapshot));
  });
  await switchTo(cached, "p");
  await cached.waitForFunction(() => !!window.releaseWorkflow.p);
  await cached.locator('[data-canvas-node-id="far"]').waitFor({ state: "attached" });
  assert.equal(await cards(cached).count(), 0, "returning to a cached project must reconcile offline edits before exposing old cards");
  await cached.evaluate(() => window.releaseWorkflow.p());
  await cached.getByRole("button", { name: "重新加载工作流" }).click();
  await cached.locator('[data-workflow-card="p-new"]').waitFor();
  assert.equal(await cached.locator('[data-workflow-card="p-instruction"]').count(), 0);
  await cached.close();

  const windows = await fixture("window");
  await windows.waitForFunction(() => window.releaseWorkflow.project_canvas_get1 && window.releaseWorkflow.canvas_workflow_get1
    && window.calls.some(({command,args}) => command === "plugin:event|listen" && args.event === "local-chat://cards-changed"));
  await windows.evaluate(async () => {
    const saved = JSON.parse(sessionStorage.getItem("workflow-p"));
    saved.revision++;
    saved.document.nodes[0] = {...saved.document.nodes[0], id:"p-other-window"};
    sessionStorage.setItem("workflow-p", JSON.stringify(saved));
    for (let i=0; i<2; i++) await window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"local-chat://cards-changed",payload:{projectId:"p"}});
    window.releaseWorkflow.project_canvas_get1();
  });
  await windows.locator('[data-canvas-node-id="far"]').waitFor({ state: "attached" });
  await windows.evaluate(() => window.releaseWorkflow.canvas_workflow_get1());
  await windows.waitForFunction(() => window.releaseWorkflow.canvas_workflow_get2 || document.querySelector("[data-workflow-card]"));
  assert.equal(await cards(windows).count(), 0, "a change from another window during entry must be reconciled before the first editable card");
  await windows.evaluate(() => window.releaseWorkflow.canvas_workflow_get2());
  await windows.locator('[data-workflow-card="p-other-window"]').waitFor();
  assert.equal(await windows.evaluate(() => window.calls.filter(item => item.command === "canvas_workflow_get").length), 2);
  await windows.close();

  const recovery = await fixture("history-failure");
  const resume = recovery.getByRole("button", { name: "重新加载工作流" });
  await resume.waitFor();
  assert.equal(await cards(recovery).count(), 0);
  assert.equal(await recovery.evaluate(() => window.calls.some(call => call.command === "canvas_workflow_save")), false);
  assert.equal(await recovery.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.run.id), "archived-run");
  await resume.click();
  await ready(recovery, "p");
  await recovery.close();

  const switching = await fixture("switch");
  await switching.waitForFunction(() => !!window.releaseWorkflow.p1);
  await switching.locator('[data-canvas-node-id="far"]').waitFor({ state: "attached" });
  assert.equal(await cards(switching).count(), 0);
  assert.equal(await create(switching).isDisabled(), true);
  await switching.getByRole("button", { name: "抓手工具" }).click();
  assert.equal(await switching.getByRole("button", { name: "抓手工具" }).getAttribute("aria-pressed"), "true");
  await switching.getByRole("button", { name: "选择工具" }).click();
  await switching.locator("[data-canvas-stage]").dblclick({ position: { x: 650, y: 340 } });
  await switching.keyboard.press("Enter");
  assert.equal(await switching.getByRole("menu", { name: "新建卡片" }).count(), 0);
  await switchTo(switching, "q");
  await switching.waitForFunction(() => !!window.releaseWorkflow.q1);
  await switchTo(switching, "p");
  await switching.waitForFunction(() => !!window.releaseWorkflow.p2);
  await switching.evaluate(() => window.releaseWorkflow.q1());
  await switching.waitForFunction(async () => (await import("/src/lib/canvasWorkflowRuntime.ts")).canvasWorkflowController("q").ready);
  assert.equal(await cards(switching).count(), 0);
  assert.equal(await create(switching).isDisabled(), true);
  await switching.evaluate(() => window.releaseWorkflow.p2());
  await ready(switching, "p");
  await switching.getByRole("textbox", { name: "反推要求" }).fill("p edited after return", { force: true });
  await switching.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes[0].prompt === "p edited after return");
  await switching.evaluate(() => window.releaseWorkflow.p1());
  await switching.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await switching.getByRole("textbox", { name: "反推要求" }).inputValue(), "p edited after return");
  assert.equal(await switching.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-q")).document.nodes[0].prompt), "q first prompt");
  await switching.close();

  const failed = await fixture("failure");
  const retry = failed.getByRole("button", { name: "重新加载工作流", exact: true });
  await retry.waitFor();
  assert.equal(await cards(failed).count(), 0);
  await failed.getByRole("button", { name: "放大", exact: true }).click();
  await retry.click();
  await ready(failed, "p");
  assert.equal(await failed.evaluate(() => window.calls.filter(call => call.command === "canvas_workflow_get").length), 2);
  assert.equal(await failed.getByRole("button", { name: "重试保存", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("workflow readiness passed: cold reconciliation, historical H3 results, native browsing, locked controls, A→B→A, project-owned edit, failed load and retry");
} finally {
  await browser.close();
  await server.close();
}
