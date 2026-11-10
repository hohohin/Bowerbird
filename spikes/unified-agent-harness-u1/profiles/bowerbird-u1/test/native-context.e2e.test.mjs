import assert from "node:assert/strict";
import test from "node:test";
import { startMeteredDeepSeekProxy } from "../../../../../apps/agent-worker/src/harness/metered-deepseek-proxy.ts";
import { DshAcpHarnessAdapter } from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { UnifiedPlanningHarnessRunner } from "../../../../../apps/agent-worker/src/harness/unified-planning-harness-runner.ts";
import { NodeDshAcpPort } from "../../../../../apps/agent-worker/src/harness/node-dsh-acp-port.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real DSH preserves long context without cost-window summaries and survives a response beyond 60s", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "bowerbird-long-context-"));
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
    phase: "execute_approved_plan", maxModelTurns: 12, control,
    upstream: { apiKey: "fixture", baseUrl: "http://127.0.0.1:43123", model: "deepseek-flash" }, allowInsecureLoopback: true,
    async fetch(_url, init) {
      const request = JSON.parse(init.body); requests.push(request);
      assert.deepEqual(request.thinking, { type: "disabled" }, "profile patches replace config; preserve the explicit provider mode");
      assert.equal(request.max_tokens, 393216);
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
  try {
    const runner = new UnifiedPlanningHarnessRunner({ runId: "native-context", async dispatch(call) {
      if (call.toolName === "read_context") return { callId: call.arguments.id,
        value: { text: `${call.arguments.id}\n${"supporting reference detail ".repeat(1100)}\n${call.arguments.id}` } };
      delivered = true;
      return { callId: "deliver", value: { terminalReason: "awaiting_result_feedback" } };
    } }, toolBridge => new DshAcpHarnessAdapter({ cwd: runtimeRoot,
      createPort: () => NodeDshAcpPort.create({ profileTemplateDir: resolve(import.meta.dirname, ".."), runtimeRoot,
        childEnvironment: toolBridge, providerEnvironment: proxy.childEnvironment(), timeoutMs: 5000, promptTimeoutMs: 0 }) }));
    const result = await runner.run({ schemaVersion: 1, runId: "native-context", checkpointVersion: 0,
      phase: "execute_approved_plan", approvedPlanHash: "a".repeat(64), compactedFacts: [], completedToolResults: [] },
    [{ type: "text", text: "Deliver the authorized poster using the supplied facts." }]);
    assert.equal(result.stopReason, "end_turn");
    assert.ok(delivered);
    assert.equal(summaries, 0, "do not silently replace original material with a summary");
    assert.ok(JSON.stringify(requests.at(-1).messages).length > 100_000);
    assert.equal(requests.some(request => JSON.stringify(request.messages).includes("<compacted-summary>")), false);
    assert.equal(usage.size, requests.length);
  } finally {
    await proxy.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
