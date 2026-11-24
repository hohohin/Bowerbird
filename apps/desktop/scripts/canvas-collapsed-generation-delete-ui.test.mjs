import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const entry = "scripts/fixtures/canvas-reference/preview.html";
const server = await createServer({ cacheDir: ".tmp/canvas-collapsed-generation-delete-vite",
  optimizeDeps: { entries: [entry] }, server: { host: "127.0.0.1", port: 1655, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const modifier = process.platform === "darwin" ? "Meta" : "Control";

try {
  for (const action of ["keyboard", "project", "original", "pinned", "original-failed", "project-reanchor"]) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(60000);
    const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
    const producer = page.locator('[data-workflow-card="producer"]');
    const image = node("session").locator('[data-conversation-image="a"]');
    const workflowContainsProducer = () => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.some(node => node.id === "producer");

    await page.goto(`${server.resolvedUrls.local[0]}${entry}`);
    await node("old").waitFor();
    await page.evaluate(async reanchor => {
      const { newWorkflowNode } = await import("/src/lib/canvasWorkflow.ts");
      const snapshot = window.snapshot(), base = snapshot.nodes[0];
      const group = 'workflow:["p","producer"]';
      const prompt = { ...base, id: "session", kind: "prompt", assetId: null, role: null, hiddenAt: null, x: 300, y: 150,
        payloadJson: JSON.stringify({ schema_version: 1, text: "H3 测试", job_id: "h3-job", turn_key: "turn",
          provider: "minimax-h3-image", status: "done", workflow_generation_group: group }) };
      const output = { ...base, id: "gen-output:h3-job:turn:0", kind: "asset", assetId: "a", role: "output",
        hiddenAt: null, x: 300, y: 150, outputIsVideo: false,
        payloadJson: JSON.stringify({ schema_version: 1, workflow_generation_group: group, workflow_source: "producer",
          execution: { job_id: "h3-job", turn_key: "turn" }, snapshot: { name: "H3 结果", width: 190, height: 150 } }) };
      snapshot.nodes = [prompt, output, { ...base, id: "copy", assetId: "a", x: 75, y: 490 }];
      const link = { id: "produced", projectId: "p", kind: "produced", fromNodeId: prompt.id,
        toNodeId: output.id, ordinal: 0, createdAt: 1 };
      snapshot.edges = [link];
      if (reanchor) {
        const next = { ...prompt, id: "later-session", createdAt: prompt.createdAt + 1,
          payloadJson: JSON.stringify({ ...JSON.parse(prompt.payloadJson), turn_key: "later" }) };
        const nextOutput = { ...output, id: "gen-output:h3-job:later:0", assetId: "b", createdAt: next.createdAt,
          payloadJson: JSON.stringify({ ...JSON.parse(output.payloadJson), execution: { job_id: "h3-job", turn_key: "later" } }) };
        snapshot.nodes.push(next, nextOutput);
        snapshot.edges.push({ ...link, id: "later-output", fromNodeId: next.id, toNodeId: nextOutput.id, createdAt: next.createdAt });
      }
      snapshot.groups = []; snapshot.groupItems = [];
      snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
      sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
      const source = { ...newWorkflowNode("generation", 850, 100, "minimax-h3-image"), id: "producer",
        activeSessionNodeId: reanchor ? "later-session" : prompt.id,
        sessionNodeIds: reanchor ? [prompt.id, "later-session"] : [prompt.id] };
      sessionStorage.setItem("workflow-p", JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [source], run: null } }));
    }, action === "project-reanchor");
    await page.reload();
    if (action === "project-reanchor") {
      await node("session").getByRole("button", { name: "上一张生成图片", exact: true }).click();
    }
    await image.waitFor();
    assert.equal(await producer.count(), 0, "completed H3 card is collected in its result");
    assert.equal(await page.evaluate(workflowContainsProducer), true);

    if (action === "keyboard" || action === "pinned") {
      if (action === "pinned") {
        await image.hover();
        await producer.getByRole("button", { name: "固定在画板上", exact: true }).click();
        await producer.getByRole("button", { name: "取消固定并收起", exact: true }).waitFor();
      }
      await image.click({ modifiers: [modifier] });
      await page.waitForFunction(() => document.querySelector('[data-canvas-node-id="session"]')?.classList.contains("is-selected"));
      await page.mouse.move(5, 5);
      if (action === "keyboard") {
        await page.evaluate(async () => {
          const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
          const controller = canvasWorkflowController("p");
          const run = { id: "busy", status: "running", order: ["producer"], lockedNodeIds: ["producer"],
            writeNodeIds: ["producer"], steps: { producer: { status: "running" } } };
          controller.document = { ...controller.document, run, runs: [run] };
        });
        await page.keyboard.press("Delete");
        await page.getByText("卡片正在使用，请先停止对应任务再删除", { exact: true }).waitFor();
        assert.equal(await image.count(), 1);
        await page.evaluate(async () => {
          const { canvasWorkflowController } = await import("/src/lib/canvasWorkflowRuntime.ts");
          const controller = canvasWorkflowController("p");
          controller.document = { ...controller.document, run: null, runs: [] };
        });
      }
      await page.keyboard.press("Delete");
    } else {
      // The fixture removes the asset instances. Match the native transaction's
      // additional hiding of the generation session when its last output is removed.
      const projectRemoval = action.startsWith("project");
      if (projectRemoval) await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          const result = await invoke(command, args);
          if (command === "remove_assets_from_project" && args.removeCanvasInstances) {
            await invoke("project_canvas_node_remove", { nodeId: "session" });
          }
          return result;
        };
      });
      await image.click({ button: "right" });
      await page.getByRole("menuitem", { name: "项目与原文件", exact: true }).click();
      if (projectRemoval) {
        await page.getByRole("menuitem", { name: "移出项目", exact: true }).click();
      } else {
        await page.getByRole("menuitem", { name: "删除原文件…", exact: true }).click();
        if (action === "original-failed") await page.evaluate(() => { window.failAssetDelete = true; });
        await page.getByRole("dialog").getByRole("button", { name: "删除原文件", exact: true }).click();
      }
    }
    if (action === "original-failed") {
      await page.getByRole("button", { name: "查看文件任务", exact: true }).click();
      await page.getByRole("dialog").getByText("查看未完成项").click();
      await page.getByRole("dialog").getByRole("button", { name: "重试失败项" }).waitFor();
      await image.waitFor();
      assert.equal(await page.evaluate(workflowContainsProducer), true, "failed recycling keeps the generation definition");
      assert.equal(await producer.count(), 0, "failed recycling restores the collapsed presentation");
      await page.close();
      console.log(`PASS collapsed H3 deletion: ${action}`);
      continue;
    }
    await node("session").waitFor({ state: "detached" });
    if (action === "project-reanchor") {
      await node("later-session").locator('[data-conversation-image="b"]').waitFor();
      assert.equal(await page.evaluate(workflowContainsProducer), true, "another output keeps the producer");
      assert.equal(await producer.count(), 0, "the generation card follows the surviving result");
      await page.close();
      console.log(`PASS collapsed H3 deletion: ${action}`);
      continue;
    }
    await page.waitForFunction(() => window.snapshot().nodes.filter(node => node.id !== "copy").every(node => node.hiddenAt != null));
    if (action === "pinned") {
      await producer.waitFor();
      assert.equal(await page.evaluate(workflowContainsProducer), true, "the explicitly pinned card is independent of its result");
      await page.close();
      console.log(`PASS collapsed H3 deletion: ${action}`);
      continue;
    }
    assert.equal(await producer.count(), 0, `${action}: the removed result must not resurrect its H3 card`);
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("workflow-p")).document.nodes.length === 0);
    if (action === "project" || action === "original") {
      const initialReads = await page.evaluate(() => {
        const reads = window.calls.filter(call => call.command === "project_canvas_get").length;
        window.emitAssetsChanged();
        return reads;
      });
      await page.waitForFunction(reads => window.calls.filter(call => call.command === "project_canvas_get").length > reads, initialReads);
      assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === "canvas_workflow_save" && !call.args.document.nodes.length).length), 1,
        "repeated native refreshes keep a single workflow removal");
    }
    if (action === "keyboard") {
      assert.equal(await node("copy").count(), 1, "another instance of the same asset remains");
      await page.keyboard.press(`${modifier}+z`);
      await image.waitFor();
      await page.waitForFunction(workflowContainsProducer);
      await page.waitForFunction(() => window.snapshot().nodes.every(node => node.hiddenAt == null));
      assert.equal(await producer.count(), 0, "undo restored the card in its collapsed state");
    }
    await page.close();
    console.log(`PASS collapsed H3 deletion: ${action}`);
  }
} finally {
  await browser.close();
  await server.close();
}
