import assert from "node:assert/strict";
import {
  DshAcpHarnessAdapter,
} from "../../../../../apps/agent-worker/src/harness/dsh-acp-harness-adapter.ts";
import { spikeRoot } from "./runtime.mjs";
import { NodeDshAcpPort } from "./dsh-acp-port.mjs";

const RECOVERY_PATCH = "profiles/bowerbird-u1/cordis.recovery.patch.yml";

const adapter = new DshAcpHarnessAdapter({
  cwd: spikeRoot,
  createPort: () => new NodeDshAcpPort({ allowNetwork: true, patches: [RECOVERY_PATCH] }),
});

const session = await adapter.open({
  schemaVersion: 1,
  runId: "run-u2-adapter-smoke",
  checkpointVersion: 3,
  phase: "execute_approved_plan",
  approvedPlanHash: "b".repeat(64),
  compactedFacts: [{ kind: "recovery_marker", value: "RECOVERY_OK" }],
  completedToolResults: [
    {
      callId: "c".repeat(64),
      toolName: "generate_image",
      argsHash: "a".repeat(64),
      result: { artifactId: "artifact-existing" },
    },
  ],
});

try {
  const result = await session.turn([
    {
      type: "text",
      text: "Read the recorded checkpoint facts. Reply exactly RECOVERY_OK:artifact-existing.",
    },
  ]);
  const text = result.committedContent
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(result.stopReason, "end_turn");
  assert.match(text, /RECOVERY_OK:artifact-existing/);
  process.stdout.write(`${JSON.stringify({
    adapter: adapter.id,
    sessionCreated: Boolean(session.sessionId),
    rebuiltFromCheckpoint: true,
    completedArtifactObserved: true,
    stopReason: result.stopReason,
  }, null, 2)}\n`);
} finally {
  await session.close();
}
