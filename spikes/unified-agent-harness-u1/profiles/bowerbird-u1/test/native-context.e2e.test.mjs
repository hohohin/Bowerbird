import assert from "node:assert/strict";
import test from "node:test";
import { startMeteredDeepSeekProxy } from "../../../../../apps/agent-worker/src/harness/metered-deepseek-proxy.ts";
import { DshAcpHarnessAdapter } from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { UnifiedPlanningHarnessRunner } from "../../../../../apps/agent-worker/src/harness/unified-planning-harness-runner.ts";
import { NodeDshAcpPort } from "../scripts/dsh-acp-port.mjs";
import { spikeRoot } from "../scripts/runtime.mjs";

test("real DSH survives a buffered response beyond 60s, owns compaction, and continues to delivery", async () => {
  const calls = new Map(), artifacts = new Map(), usage = new Map();
  const control = {
    async prepareTool(args) {
      if (calls.has(args.callId)) return { ...calls.get(args.callId), reused: true };
      const call = { ...args, status: "prepared", reused: false }; calls.set(args.callId, call); return call;
    },
    async markToolSubmitted(args) {
      const call = { ...calls.get(args.callId), ...args, status: "submitted" }; calls.set(args.callId, call); return call;
    },
    async completeTool(args) {
      const call = { ...calls.get(args.callId), ...args }; calls.set(args.callId, call); return call;
    },
    async uploadDiagnostic(args) {
      const artifact = { artifactId: args.sourceCallId, objectKey: args.sourceCallId, url: args.sourceCallId,
        bytes: args.bytes.length, sha256: args.sha256 };
      artifacts.set(args.sourceCallId, { artifact, bytes: args.bytes }); return artifact;
    },
    async getArtifactByCall(_run, _lease, id) { return artifacts.get(id).artifact; },
    async downloadVerifiedBytes(id) { return artifacts.get(id).bytes; },
    async recordUsage(args) { usage.set(args.callId, args); },
  };
  const facts = ["BRAND_NAVY", "COPY_EXACT", "LAYOUT_ASYMMETRIC", "OUTPUT_1080", "DOCUMENT_READY"];
  const requests = [];
  let step = 0, summaries = 0, delivered = false;
  const proxy = await startMeteredDeepSeekProxy({ runId: "native-context", leaseId: "lease",
    phase: "execute_approved_plan", maxModelTurns: 12, maxOutputTokens: 8000, control,
    upstream: { apiKey: "fixture", baseUrl: "http://127.0.0.1:43123", model: "deepseek-v4-flash" }, allowInsecureLoopback: true,
    async fetch(_url, init) {
      const request = JSON.parse(init.body); requests.push(request);
      assert.deepEqual(request.thinking, { type: "disabled" }, "profile patches replace config; preserve the explicit provider mode");
      if (requests.length === 1) await new Promise(resolve => setTimeout(resolve, 61_000));
      const compacting = String(request.messages.at(-1)?.content).includes("You are now acting as a compaction engine");
      let delta;
      if (compacting) {
        summaries++;
        assert.equal(request.max_tokens, 4000);
        assert.ok(init.body.includes(facts[0]), "the native summarizer must receive earlier facts");
        delta = { content: "## Current Work\nDeliver the poster.\n## Critical Context\n" + facts.slice(0, step).join("\n") };
      } else {
        if (step > 0) for (const fact of facts.slice(0, step)) assert.ok(init.body.includes(fact), `lost ${fact}`);
        const name = step < facts.length ? "read_context" : "call_tool";
        const args = step < facts.length ? { id: facts[step++] }
          : { actionId: "deliver", toolName: "finalize_output", inputJson: "{}" };
        delta = { tool_calls: [{ index: 0, id: `native-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      const inputTokens = Math.ceil(init.body.length / 3);
      const body = `data: ${JSON.stringify({ id: `response-${requests.length}`, choices: [{ index: 0, delta,
        finish_reason: compacting ? "stop" : "tool_calls" }], usage: { prompt_tokens: inputTokens, completion_tokens: 100,
          total_tokens: inputTokens + 100 } })}\n\ndata: [DONE]\n\n`;
      return { ok: true, status: 200, async text() { return body; } };
    },
  });
  const previous = Object.fromEntries(["BOWERBIRD_U1_ALLOW_NETWORK", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"].map(key => [key, process.env[key]]));
  Object.assign(process.env, proxy.childEnvironment(), { BOWERBIRD_U1_ALLOW_NETWORK: "1" });
  try {
    const runner = new UnifiedPlanningHarnessRunner({ runId: "native-context", async dispatch(call) {
      if (call.toolName === "read_context") return { callId: call.arguments.id,
        value: { text: `${call.arguments.id}\n${"supporting reference detail ".repeat(1100)}\n${call.arguments.id}` } };
      delivered = true;
      return { callId: "deliver", value: { terminalReason: "awaiting_result_feedback" } };
    } }, toolBridge => new DshAcpHarnessAdapter({ cwd: spikeRoot,
      createPort: () => new NodeDshAcpPort({ allowNetwork: true, patches: ["profiles/bowerbird-u1/cordis.bridge.patch.yml"], toolBridge }) }));
    const result = await runner.run({ schemaVersion: 1, runId: "native-context", checkpointVersion: 0,
      phase: "execute_approved_plan", approvedPlanHash: "a".repeat(64), compactedFacts: [], completedToolResults: [] },
    [{ type: "text", text: "Deliver the authorized poster using the supplied facts." }]);
    assert.equal(result.stopReason, "end_turn");
    assert.ok(delivered);
    assert.ok(summaries > 0, "exercise native DSH compaction, not just a short tool loop");
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes("<compacted-summary>")));
    assert.equal(usage.size, requests.length, "native summary calls also pass through metering");
  } finally {
    await proxy.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
