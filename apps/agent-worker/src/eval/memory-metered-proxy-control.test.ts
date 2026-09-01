import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { EvalMeteredProxyControl } from "./memory-metered-proxy-control.ts";

test("U4 eval metered control persists and restores one model result without drift", async () => {
  const control = new EvalMeteredProxyControl();
  const identity = {
    runId: "eval-cie-01",
    leaseId: "lease-cie-01",
    callId: "a".repeat(64),
    phase: "compose_plan",
    toolName: "deepseek_chat_completion",
    argsHash: "b".repeat(64),
  };
  equal((await control.prepareTool(identity)).status, "prepared");
  equal((await control.markToolSubmitted(identity)).status, "submitted");
  const bytes = new TextEncoder().encode("{\"ok\":true}");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = await control.uploadDiagnostic({
    ...identity,
    sourceCallId: identity.callId,
    stepId: "model-compose_plan",
    bytes,
    sha256,
  });
  await control.recordUsage({ ...identity, inputUnits: 11, outputUnits: 4 });
  await control.completeTool({ ...identity, status: "succeeded", resultObjectKey: artifact.objectKey, resultHash: sha256 });
  equal((await control.prepareTool(identity)).status, "succeeded");
  deepEqual(await control.downloadVerifiedBytes(artifact.url!, { sha256, bytes: bytes.byteLength }), bytes);
  deepEqual(control.usageForRun(identity.runId), { promptTokens: 11, completionTokens: 4, calls: 1 });
  await rejects(() => control.prepareTool({ ...identity, argsHash: "c".repeat(64) }), /controlled_eval_model_args_drift/);
});
