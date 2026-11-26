import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({ cacheDir: ".tmp/canvas-workflow-node-lock/vite", optimizeDeps: { entries: [entry] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });

function card(page, id) { return page.locator(`[data-workflow-card="${id}-card"]`); }
function promptEditor(page, id) { return card(page, id).getByLabel("卡片指令", { exact: true }); }
function aspectRatio(page, id) { return card(page, id).locator('button[title="选择画面比例"]'); }
function removeButton(page, id) { return card(page, id).getByRole("button", { name: "删除卡片", exact: true }); }
function uppers(page, id) { return card(page, id).getByRole("button", { name: "添加上游", exact: true }); }
function waitForRunningCard(page, id) { return card(page, id).and(page.locator('[aria-busy="true"]')).waitFor(); }
function storedWorkflow(page) { return page.evaluate(() => JSON.parse(sessionStorage.getItem("workflow-p")).document); }
function waitForSubmission(page, count) { return page.waitForFunction(count => window.lockFixture.submissions.length === count, count); }
function finish(page, index, resultId) { return page.evaluate(([index, resultId]) => window.lockFixture.finish[index](resultId), [index, resultId]); }

async function withWorkflow(mode, verify) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${server.resolvedUrls.local[0]}${entry}`);
    await page.locator('[data-canvas-node-id="old"]').waitFor();
    await page.evaluate(async mode => {
      const { api } = await import("/src/lib/api.ts");
      const { newWorkflowNode, invalidateWorkflow } = await import("/src/lib/canvasWorkflow.ts");
      const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
      const { publishGeneration } = await import("/scripts/fixtures/canvas-reference/generation.ts");
      const controller = canvasWorkflowController("p");
      const assets = await api.getAssetsByIds(["a", "b", "c", "d"]);
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      const byPath = new Map(assets.map(asset => [asset.store_path, asset.id]));
      api.localAgentFindAssetId = async path => byPath.get(path);
      const fixture = window.lockFixture = { controller, submissions: [], finish: [], invalidateWorkflow };
      window.store.setState({
        codexHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
        cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 10, sub: 0, topup: 0 } },
        startGeneration: async (...args) => {
          const { jobId, turnKey } = args[12];
          const result = new Promise(resolve => {
            fixture.finish.push(async resultId => {
              const asset = byId.get(resultId);
              await publishGeneration(args, [asset.store_path]);
              await api.projectCanvasNodeUpdate(`gen-output:${jobId}:${turnKey}:0`, { payloadJson: JSON.stringify({
                schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height },
                execution: { job_id: jobId, turn_key: turnKey },
              }) });
              window.emitChange();
              resolve();
            });
          });
          fixture.submissions.push({ prompt: args[0], references: args[1].map(asset => asset.id), ratio: args[2] });
          await result;
          return { accepted: true, jobId };
        },
      });
      const wire = (from, to) => ({ nodeId: `${from}-card`, portId: "image", autoConnect: `${from}-${to}` });
      const make = (id, x, y, image) => ({ ...newWorkflowNode("generation", x, y, "codex"), id: `${id}-card`,
        prompt: `卡片 ${id.toUpperCase()}`, inputs: { image }, trigger: id === "a" });
      const nodes = [make("a", 60, 110, [{ assetId: "existing", autoConnect: "existing-a" }]), make("b", 490, 110, [wire("a", "b")]),
        make("c", 910, 110, mode === "latest" ? [wire("b", "c"), wire("a", "c")] : [wire("b", "c")])];
      if (mode !== "latest") nodes.push(make("d", 490, 545, [wire("a", "d")]));
      await controller.load();
      await controller.edit(nodes);
      fixture.execution = controller.start("a-card").then(() => null, error => String(error));
    }, mode);
    await waitForSubmission(page, 1);
    await verify(page);
    assert.equal(await page.evaluate(() => window.lockFixture.execution), null);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

try {
  await withWorkflow("latest", async page => {
    await waitForRunningCard(page, "a");
    assert.equal(await promptEditor(page, "a").getAttribute("contenteditable"), "false");
    assert.equal(await aspectRatio(page, "a").isDisabled(), true);
    assert.equal(await uppers(page, "a").isDisabled(), true);
    for (const id of ["b", "c"]) {
      assert.equal(await card(page, id).getAttribute("aria-busy"), "false");
      assert.equal(await promptEditor(page, id).getAttribute("contenteditable"), "true", `pending ${id} prompt is editable`);
      assert.equal(await aspectRatio(page, id).isDisabled(), false);
      assert.equal(await uppers(page, id).isDisabled(), false);
    }
    const inFlight = await storedWorkflow(page);
    const blocked = await page.evaluate(async () => {
      const { controller } = window.lockFixture;
      const addReference = id => controller.connectAutomatic([{ type: "image", binding: { assetId: "d" } }], { nodeId: `${id}-card` });
      const outcomes = [];
      for (const operation of [
        () => controller.edit(controller.document.nodes.map(node => node.id === "a-card" ? { ...node, prompt: "运行中修改" } : node)),
        () => controller.disconnectAutomatic("existing-a"), () => addReference("a"), () => controller.start("b-card", true),
      ]) outcomes.push(await Promise.resolve().then(operation).then(() => false, () => true));
      await controller.start("a-card", true).catch(() => {});
      await addReference("b");
      return { outcomes, submissions: window.lockFixture.submissions.length };
    });
    assert.deepEqual(blocked, { outcomes: [true, true, true, true], submissions: 1 });
    assert.deepEqual((await storedWorkflow(page)).run.steps["a-card"].generationRunInput, inFlight.run.steps["a-card"].generationRunInput);

    await promptEditor(page, "b").fill("B 等待期间更新的提示词");
    await aspectRatio(page, "b").click();
    await page.getByRole("option", { name: "9:16", exact: true }).click();
    await page.waitForFunction(() => {
      const update = JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "b-card");
      return update.prompt === "B 等待期间更新的提示词" && update.ratio === "9:16";
    });
    await finish(page, 0, "a");
    await waitForSubmission(page, 2);
    const liveB = () => page.evaluate(() => window.lockFixture.submissions[1]);
    const bInput = await liveB();
    assert.match(bInput.prompt, /B 等待期间更新的提示词/);
    assert.deepEqual(bInput.references.toSorted(), ["a", "d"]);
    assert.equal(bInput.ratio, "9:16");
    await waitForRunningCard(page, "b");
    assert.equal(await promptEditor(page, "b").getAttribute("contenteditable"), "false");
    assert.equal(await uppers(page, "b").isDisabled(), true);
    assert.equal(await promptEditor(page, "c").getAttribute("contenteditable"), "true");

    const bCheckpoint = (await storedWorkflow(page)).run.steps["b-card"].generationRunInput;
    await page.evaluate(async () => {
      const { controller, invalidateWorkflow } = window.lockFixture;
      const nodes = controller.document.nodes.map(node => node.id === "a-card" ? { ...node, prompt: "A 完成后更新的提示词" } : node);
      await controller.edit(invalidateWorkflow(nodes, "a-card"));
    });
    const edited = await storedWorkflow(page);
    assert.equal(edited.nodes.find(node => node.id === "a-card").prompt, "A 完成后更新的提示词");
    assert.deepEqual(edited.run.steps["b-card"].generationRunInput, bCheckpoint);
    assert.deepEqual(await liveB(), bInput);
    await finish(page, 1, "b");
    await waitForSubmission(page, 3);
    const cInput = await page.evaluate(() => window.lockFixture.submissions[2]);
    assert.deepEqual(cInput.references.toSorted(), ["a", "b"], "this run retains completed A's output for C");
    await finish(page, 2, "c");
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.run.status === "done");

    const reloaded = await page.evaluate(async () => {
      const { CanvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
      const projectId = "card-lock-restore";
      const snapshot = JSON.parse(sessionStorage.getItem("workflow-p"));
      const ids = ["a-card", "b-card"];
      const run = { ...snapshot.document.run, status: "running", order: ids, lockedNodeIds: ids, writeNodeIds: ids,
        steps: { "a-card": { status: "running", jobId: "active-video", turnKey: "active-turn", videoJobActive: true }, "b-card": { status: "running" } } };
      sessionStorage.setItem(`workflow-${projectId}`, JSON.stringify({ ...snapshot, document: { ...snapshot.document, run, runs: [run] } }));
      const controller = new CanvasWorkflowController(projectId);
      await controller.load();
      return { status: controller.document.run.status, active: controller.isLocked("a-card"), idle: controller.isLocked("b-card") };
    });
    assert.deepEqual(reloaded, { status: "waiting", active: true, idle: false }, "restore locks only waits with a live external task");
  });
  console.log("PASS card edit locks, latest pending inputs, accepted snapshots, cross-run write exclusion, and waiting after restart");

  for (const mode of ["detach", "delete"]) {
    await withWorkflow(mode, async page => {
      if (mode === "detach") {
        await card(page, "b").locator('button[title="断开连接"]').click();
        await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.find(node => node.id === "b-card").inputs.image?.length);
      } else {
        await removeButton(page, "b").click();
        await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.some(node => node.id === "b-card"));
        const { run } = await storedWorkflow(page);
        for (const ids of [run.order, run.lockedNodeIds, run.writeNodeIds]) assert.ok(!ids.includes("b-card"));
      }
      await finish(page, 0, "a");
      await waitForSubmission(page, 2);
      assert.match(await page.evaluate(() => window.lockFixture.submissions[1].prompt), /卡片 D/);
      await finish(page, 1, "d");
      await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.run.status === "done");
      assert.equal(await page.evaluate(() => window.lockFixture.submissions.length), 2);
    });
    console.log(`PASS ${mode} skips pending branch and finishes the remaining branch`);
  }
} finally {
  await browser.close();
  await server.close();
}
