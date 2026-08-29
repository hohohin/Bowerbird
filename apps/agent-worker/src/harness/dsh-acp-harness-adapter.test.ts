import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";

import { computeArgsHash } from "../kernel/tool-ledger.ts";
import type { HarnessCheckpointSeed, HarnessPromptBlock } from "./contracts.ts";
import {
  DshAcpHarnessAdapter,
  type DshAcpPort,
} from "./dsh-acp-harness-adapter.ts";

class FakeAcpPort implements DshAcpPort {
  initialized = 0;
  newSessions = 0;
  cancelCalls = 0;
  disposed = 0;
  readonly prompts: HarnessPromptBlock[][] = [];

  async initialize() {
    this.initialized++;
    return { protocolVersion: 1 };
  }

  async newSession() {
    this.newSessions++;
    return { sessionId: `fresh-${this.newSessions}` };
  }

  async prompt(
    args: { sessionId: string; prompt: HarnessPromptBlock[] },
    onCommittedContent: (content: HarnessPromptBlock) => void,
  ) {
    this.prompts.push(args.prompt);
    onCommittedContent({ type: "text", text: `committed:${args.sessionId}` });
    return { stopReason: "end_turn" };
  }

  async cancel() {
    this.cancelCalls++;
  }

  async dispose() {
    this.disposed++;
  }
}

function seed(): HarnessCheckpointSeed {
  return {
    schemaVersion: 1,
    runId: "run-u2",
    checkpointVersion: 7,
    phase: "execute_approved_plan",
    approvedPlanHash: "b".repeat(64),
    compactedFacts: [{ kind: "approved", value: "one step" }],
    completedToolResults: [
      {
        callId: "c".repeat(64),
        toolName: "generate_image",
        argsHash: computeArgsHash({ prompt: "approved" }),
        result: { artifactId: "artifact-existing" },
      },
    ],
  };
}

test("DSH adapter rebuilds a fresh connection-scoped session from Bowerbird checkpoint", async () => {
  const ports: FakeAcpPort[] = [];
  const adapter = new DshAcpHarnessAdapter({
    cwd: "D:/isolated/run-u2",
    createPort() {
      const port = new FakeAcpPort();
      ports.push(port);
      return port;
    },
  });

  const first = await adapter.open(seed());
  const firstResult = await first.turn([{ type: "text", text: "continue" }]);
  equal(firstResult.stopReason, "end_turn");
  deepEqual(firstResult.committedContent, [{ type: "text", text: "committed:fresh-1" }]);
  equal(ports[0]?.initialized, 1);
  equal(ports[0]?.newSessions, 1);
  ok(/BOWERBIRD_CHECKPOINT_V1/.test((ports[0]?.prompts[0]?.[0] as { text: string }).text));
  ok(/artifact-existing/.test((ports[0]?.prompts[0]?.[0] as { text: string }).text));

  await first.turn([{ type: "text", text: "next" }]);
  deepEqual(ports[0]?.prompts[1], [{ type: "text", text: "next" }]);
  await first.cancel();
  equal(ports[0]?.cancelCalls, 1);
  await first.close();
  equal(ports[0]?.disposed, 1);
  await rejects(() => first.turn([{ type: "text", text: "late" }]), /session_closed/);

  const rebuilt = await adapter.open(seed());
  await rebuilt.turn([{ type: "text", text: "continue after crash" }]);
  equal(ports.length, 2);
  ok(/BOWERBIRD_CHECKPOINT_V1/.test((ports[1]?.prompts[0]?.[0] as { text: string }).text));
  await rebuilt.close();
});

test("DSH adapter rejects malformed completed-call identity before spawning a port", async () => {
  let created = 0;
  const adapter = new DshAcpHarnessAdapter({
    cwd: "D:/isolated/run-u2",
    createPort() {
      created++;
      return new FakeAcpPort();
    },
  });
  const invalid = seed();
  invalid.completedToolResults[0] = { ...invalid.completedToolResults[0]!, argsHash: "not-a-hash" };
  await rejects(() => adapter.open(invalid), /invalid_checkpoint/);
  const staleApproval = seed();
  staleApproval.approvedPlanHash = "not-a-plan-hash";
  await rejects(() => adapter.open(staleApproval), /invalid_checkpoint/);
  equal(created, 0);
});
