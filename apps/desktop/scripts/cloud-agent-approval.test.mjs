import assert from "node:assert/strict";
import test from "node:test";
import { agentApprovalMode, agentApprovalScope, automaticAgentApproval, automaticAgentResultAcceptance, autoApproveAgentRun, loadAgentApprovalModes, saveAgentApprovalModes } from "../src/lib/cloudAgentApproval.ts";
import { enqueueCloudAgentRunOperation } from "../src/lib/cloudAgentRuntime.ts";

function fixture() {
  return { runId: "r", projectId: "p", threadId: "t", skillId: "bowerbird-unified-agent", status: "awaiting_approval",
    snapshot: { run: { skill_version: "0.1.0" }, approvals: [{ id: "a", status: "pending", proposal: { schemaVersion: 3 }, expires_at: "2099-01-01T00:00:00Z" }] } };
}

test("approval mode defaults to request and stays within its project thread", () => {
  const run = fixture();
  const modes = { [agentApprovalScope(run)]: "auto" };
  assert.equal(agentApprovalMode(run, {}), "request");
  assert.equal(agentApprovalMode(run, modes), "auto");
  assert.equal(agentApprovalMode({ ...run, runId: "revision" }, modes), "auto");
  assert.equal(agentApprovalMode({ ...run, threadId: "other" }, modes), "request");
  assert.equal(agentApprovalMode({ ...run, projectId: "other" }, modes), "request");
  assert.equal(agentApprovalMode({ ...run, projectId: null }, modes), "request");
});

function resultFixture() {
  const run = fixture();
  run.status = "awaiting_result_feedback";
  run.snapshot.artifacts = [{ id: "final", role: "final_result", mime: "image/png", user_visible: true }];
  return run;
}

test("automatic acceptance requires current thread authorization and visible results", () => {
  const run = resultFixture();
  const modes = { [agentApprovalScope(run)]: "auto" };
  assert.equal(automaticAgentResultAcceptance(run, modes), true);
  assert.equal(automaticAgentResultAcceptance(run, {}), false);
  assert.equal(automaticAgentResultAcceptance({ ...run, threadId: "other" }, modes), false);
  assert.equal(automaticAgentResultAcceptance({ ...run, projectId: null }, modes), false);
  for (const status of ["running", "awaiting_clarification", "failed", "cancelled", "succeeded"]) {
    assert.equal(automaticAgentResultAcceptance({ ...run, status }, modes), false);
  }
  assert.equal(automaticAgentResultAcceptance({ ...run, snapshot: { ...run.snapshot, artifacts: [] } }, modes), false);
  run.snapshot.artifacts[0].role = "full_page_screenshot";
  assert.equal(automaticAgentResultAcceptance(run, modes), true, "HTML results also accept automatically");
});

test("acceptance is serialized once and cancelled when authorization is revoked while queued", async () => {
  let run = resultFixture();
  let modes = { [agentApprovalScope(run)]: "auto" };
  let accepted = 0;
  const dependencies = { getRun: () => run, getModes: () => modes, isActive: () => true,
    approve: async () => { throw new Error("result must use feedback"); },
    accept: async () => { accepted++; return { ...run, status: "succeeded", feedbackAction: "accept" }; },
    updateRun: next => { run = next; } };
  await Promise.all([autoApproveAgentRun("r", dependencies), autoApproveAgentRun("r", dependencies)]);
  assert.equal(accepted, 1);
  assert.equal(run.feedbackAction, "accept");
  run = resultFixture();
  let release;
  const blocked = enqueueCloudAgentRunOperation("r", () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const queued = autoApproveAgentRun("r", dependencies);
  modes = {};
  release(); await blocked; await queued;
  assert.equal(accepted, 1);
});

test("stored modes restore only explicit auto authorization and tolerate corrupt storage", () => {
  let stored = "garbage";
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  assert.deepEqual(loadAgentApprovalModes(), {});
  const modes = { [agentApprovalScope(fixture())]: "auto" };
  saveAgentApprovalModes(modes);
  assert.deepEqual(loadAgentApprovalModes(), modes);
  stored = '{"one":true,"two":"request","three":"auto"}';
  assert.deepEqual(loadAgentApprovalModes(), { three: "auto" });
  delete globalThis.localStorage;
});

test("auto approval respects current skill, expiry, pending status and manual interactions", () => {
  const run = fixture();
  const modes = { [agentApprovalScope(run)]: "auto" };
  assert.equal(automaticAgentApproval(run, modes)?.id, "a");
  for (const status of ["running", "cancelled", "failed", "succeeded", "awaiting_clarification", "awaiting_result_feedback"]) {
    assert.equal(automaticAgentApproval({ ...run, status }, modes), null);
  }
  assert.equal(automaticAgentApproval({ ...run, threadId: null }, modes), null);
  assert.equal(automaticAgentApproval({ ...run, snapshot: { ...run.snapshot, run: { skill_version: "old" } } }, modes), null);
  for (const change of [{ status: "approved" }, { status: "rejected" }, { proposal: undefined }, { expires_at: "2000-01-01" }, { expires_at: "invalid" }]) {
    assert.equal(automaticAgentApproval({ ...run, snapshot: { ...run.snapshot, approvals: [{ ...run.snapshot.approvals[0], ...change }] } }, modes), null);
  }
});

test("duplicate automatic decisions serialize; each new revision gets its own approval", async () => {
  let run = fixture();
  const modes = { [agentApprovalScope(run)]: "auto" };
  const calls = [];
  const dependencies = { getRun: () => run, getModes: () => modes, isActive: () => true,
    approve: async (_runId, id) => { calls.push(id); return { ...run, status: "running" }; },
    updateRun: next => { run = next; } };
  await Promise.all([autoApproveAgentRun("r", dependencies), autoApproveAgentRun("r", dependencies)]);
  assert.deepEqual(calls, ["a"]);
  run = fixture(); run.snapshot.approvals[0].id = "revision";
  await autoApproveAgentRun("r", dependencies);
  assert.deepEqual(calls, ["a", "revision"]);
});

test("revocation, manual decision and unmount are rechecked after queued work", async () => {
  for (const action of ["revoke", "manual", "unmount"]) {
    let run = fixture(); let modes = { [agentApprovalScope(run)]: "auto" }; let active = true;
    let release;
    const blocked = enqueueCloudAgentRunOperation("r", () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    let calls = 0;
    const pending = autoApproveAgentRun("r", { getRun: () => run, getModes: () => modes, isActive: () => active,
      approve: async () => { calls++; return run; }, updateRun: next => { run = next; } });
    if (action === "revoke") modes = {};
    if (action === "manual") run.status = "running";
    if (action === "unmount") active = false;
    release(); await blocked; await pending;
    assert.equal(calls, 0, action);
  }
});
