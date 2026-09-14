import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 1575, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1575/scripts/fixtures/canvas-reference/preview.html");
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const [{ useStore }, { api }, { default: React }, { default: { createRoot } }, { CloudAgentRuntimeCoordinator }] = await Promise.all([
      import("/src/store.ts"), import("/src/lib/api.ts"), import("/node_modules/.vite/deps/react.js"),
      import("/node_modules/.vite/deps/react-dom_client.js"), import("/src/components/CloudAgentRuntimeCoordinator.tsx"),
    ]);
    window.store = useStore;
    window.decisions = []; window.notices = []; window.failApproval = false;
    window.accepted = 0; window.ingested = 0; window.failAcceptance = false;
    window.addEventListener("bowerbird://notify", event => window.notices.push(event.detail.message));
    window.makeRun = (id = "initial", threadId = "t") => ({ runId: "run", conversationId: "conversation", skillId: "bowerbird-unified-agent",
      status: "awaiting_approval", projectId: "p", threadId, intentPrompt: "生成产品海报", referenceAssetIds: [], createdAt: 1, updatedAt: 1,
      snapshot: { run: { skill_version: "0.1.0", agent_runtime: "dsh", progress: 20, budget_credits: 30 }, artifacts: [], clarifications: [], events: [],
        approvals: [{ id, kind: "unified_agent_plan", status: "pending", requested_at: "2026-09-11T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
          planned_tool_count: 1, estimated_additional_credits: 10,
          proposal: { schemaVersion: 3, title: "产品海报", summary: "保留产品主体，生成一张海报", assetIds: [], outputCount: 1, modelTurns: 8,
            capabilities: [{ tool: "generate_image", maxCalls: 1 }] } }] } });
    const run = window.makeRun();
    useStore.setState({ cloudAgentRuns: { run }, cloudAgentRunOrder: ["run"], agentApprovalModes: {} });
    api.cloudAgentGet = async id => structuredClone(useStore.getState().cloudAgentRuns[id]);
    api.cloudAgentDecideApproval = async (id, approvalId, approve) => {
      window.decisions.push({ id, approvalId, approve });
      if (window.failApproval) throw new Error("模拟审批失败");
      const current = useStore.getState().cloudAgentRuns[id];
      return { ...current, status: "running", updatedAt: current.updatedAt + 1,
        snapshot: { ...current.snapshot, approvals: current.snapshot.approvals.map(item => item.id === approvalId ? { ...item, status: "approved" } : item) } };
    };
    window.makeResult = () => {
      const result = window.makeRun("result");
      result.status = "awaiting_result_feedback";
      result.snapshot.artifacts = ["one", "two"].map(id => ({ id, role: "final_result", mime: "image/png", sha256: id, user_visible: true }));
      return result;
    };
    api.cloudAgentFeedback = async (id, action) => {
      if (action !== "accept") throw new Error("unexpected feedback");
      window.accepted++;
      if (window.failAcceptance) throw new Error("模拟接受结果失败");
      return { ...useStore.getState().cloudAgentRuns[id], status: "succeeded", feedbackAction: "accept" };
    };
    api.cloudAgentIngestArtifacts = async id => {
      window.ingested++;
      const { cloudAgentIngestionFingerprint } = await import("/src/lib/cloudAgentRuntime.ts");
      const current = useStore.getState().cloudAgentRuns[id];
      const next = { ...current, finalAssetId: "asset-one", snapshot: { ...current.snapshot,
        artifacts: current.snapshot.artifacts.map(item => ({ ...item, downloaded_at: "2026-09-11T00:00:00Z" })),
        _bowerbirdAgentIngestV1: { schemaVersion: 1, fingerprint: cloudAgentIngestionFingerprint(current), completedAt: Date.now() } } };
      useStore.getState().updateCloudAgentRun(next);
      return [{ id: "asset-one" }, { id: "asset-two" }];
    };
    api.cloudAgentPreviewArtifact = async (runId, artifactId) => ({ runId, artifactId, path: "/missing-preview.png", mime: "image/png" });
    window.launch(true); window.addAgentGroup();
    const root = document.createElement("div"); document.body.append(root);
    createRoot(root).render(React.createElement(React.StrictMode, null, React.createElement(CloudAgentRuntimeCoordinator)));
  });
  const card = page.locator('[data-canvas-node-id="agent-group:run:0:0"]');
  const toggle = card.getByRole("switch", { name: "自行批准" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => window.decisions.length), 0);
  const position = await card.evaluate(element => {
    const card = element.getBoundingClientRect(); const button = element.querySelector('[role="switch"]').getBoundingClientRect();
    return { left: button.left - card.left, bottom: card.bottom - button.bottom, width: card.width };
  });
  assert.ok(position.left < position.width / 4 && position.bottom < 25, JSON.stringify(position));
  await toggle.click();
  assert.equal(await page.evaluate(() => window.store.getState().genPanelOpen), false, "toggle must not open or drag the card");
  await page.waitForFunction(() => window.decisions.length === 1);
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => window.decisions.length), 1);
  // A revision in the same thread inherits authorization while the inspector is closed.
  await page.evaluate(() => window.store.getState().updateCloudAgentRun(window.makeRun("revision")));
  await page.waitForFunction(() => window.decisions.length === 2);
  await toggle.click();
  await page.evaluate(() => window.store.getState().updateCloudAgentRun(window.makeRun("manual")));
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => window.decisions.length), 2);
  // Both surfaces share state; clarification still requires a human answer.
  await card.locator("strong").click();
  await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "自行批准" }).count(), 2);
  await page.getByRole("switch", { name: "自行批准" }).last().click();
  await page.waitForFunction(() => window.decisions.length === 3);
  await page.screenshot({ path: ".tmp/agent-approval-mode.png" });
  await page.evaluate(() => { const run = window.makeRun("question"); run.status = "awaiting_clarification"; window.store.getState().updateCloudAgentRun(run); });
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => window.decisions.length), 3);
  // Request mode still waits for manual acceptance; turning auto on accepts and ingests in the background.
  await page.getByRole("switch", { name: "自行批准" }).last().click();
  await page.evaluate(() => window.store.getState().updateCloudAgentRun(window.makeResult()));
  await page.getByRole("button", { name: "接受结果", exact: true }).waitFor();
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => window.accepted), 0);
  await page.evaluate(() => window.store.getState().setGenPanelOpen(false));
  await toggle.click();
  await page.waitForFunction(() => window.ingested === 1);
  await page.waitForTimeout(2800);
  assert.deepEqual(await page.evaluate(() => [window.accepted, window.ingested]), [1, 1]);
  assert.equal(await page.evaluate(() => window.store.getState().cloudAgentRuns.run.snapshot.artifacts.every(item => !!item.downloaded_at)), true);
  // Failed acceptance does not ingest and returns to manual mode without repeated requests.
  await page.evaluate(() => { window.failAcceptance = true; window.store.getState().updateCloudAgentRun(window.makeResult()); });
  await page.waitForFunction(() => window.accepted === 2);
  await page.waitForTimeout(2800);
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.deepEqual(await page.evaluate(() => [window.accepted, window.ingested]), [2, 1]);
  // Failure returns to manual mode instead of repeatedly submitting a paid approval.
  await page.evaluate(() => { window.notices = []; window.failApproval = true; window.store.getState().updateCloudAgentRun(window.makeRun("failure")); });
  await toggle.click();
  await page.waitForFunction(() => window.notices.some(message => message.includes("自行批准失败")));
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await page.waitForTimeout(2800);
  assert.equal(await page.evaluate(() => window.decisions.length), 4);
  await toggle.click();
  assert.equal(await page.evaluate(async () => {
    const { loadAgentApprovalModes, agentApprovalMode } = await import("/src/lib/cloudAgentApproval.ts");
    return agentApprovalMode(window.makeRun(), loadAgentApprovalModes());
  }), "auto");
  assert.deepEqual(errors, []);
  console.log("Agent approval UI passed: card placement, mode sync, background execution, revisions, revocation, automatic acceptance and whole-group ingestion, manual feedback, failure fallback, persistence");
} catch (error) {
  console.error("UI errors:", errors);
  await page.screenshot({ path: ".tmp/agent-approval-failure.png" });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
