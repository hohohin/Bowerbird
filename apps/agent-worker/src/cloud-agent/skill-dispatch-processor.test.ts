import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { AgentControlClient } from "../control-plane/agent-control-client.ts";
import { SkillDispatchProcessor } from "./html-layout-run-processor.ts";
import type { AgentRunContext, AgentRunProcessor } from "./runtime.ts";

function context(): AgentRunContext {
  return {
    claimed: {
      run: {
        id: "run-unified-dispatch",
        conversationId: "conversation-unified-dispatch",
        skillId: "bowerbird-unified-agent",
        skillVersion: "0.1.0",
        inputManifestHash: "a".repeat(64),
        approvedPlanHash: null,
        plannedToolCount: null,
        resultFeedbackAction: null,
        budgetCredits: 30,
        pricingVersion: 1,
        checkpointHash: null,
        snapshotSchemaVersion: null,
      },
      lease: { leaseId: "lease-unified-dispatch", leaseSeconds: 60 },
    },
    control: {} as AgentControlClient,
    signal: { aborted: false, cancelRequested: false, leaseLost: false, stopRequested: false },
  };
}

function controlledContext(agentRuntime?: "legacy_kernel" | "dsh"): AgentRunContext {
  const base = context();
  return {
    ...base,
    claimed: {
      ...base.claimed,
      run: {
        ...base.claimed.run,
        id: `run-controlled-${agentRuntime ?? "historical"}`,
        skillId: "bowerbird-controlled-image-edit",
        skillVersion: "0.1.2",
        ...(agentRuntime ? { agentRuntime } : {}),
      },
    },
  };
}

const unused: AgentRunProcessor = { async process() { throw new Error("wrong_processor"); } };

test("formal Skill dispatcher routes the pinned unified Skill only to its injected processor", async () => {
  let unifiedCalls = 0;
  const unified: AgentRunProcessor = { async process() { unifiedCalls += 1; } };
  await new SkillDispatchProcessor(unused, unused, unified).process(context());
  equal(unifiedCalls, 1);
});

test("formal Skill dispatcher keeps the unified runner unavailable unless explicitly injected", async () => {
  await rejects(
    () => new SkillDispatchProcessor(unused, unused).process(context()),
    /agent_skill_runner_unavailable/,
  );
});

test("pre-U4 and explicit legacy controlled Runs stay on the legacy Kernel", async () => {
  let legacyCalls = 0;
  let dshCalls = 0;
  const legacy: AgentRunProcessor = { async process() { legacyCalls += 1; } };
  const dsh: AgentRunProcessor = { async process() { dshCalls += 1; } };
  const dispatcher = new SkillDispatchProcessor(legacy, unused, undefined, { controlledDsh: dsh });

  await dispatcher.process(controlledContext());
  await dispatcher.process(controlledContext("legacy_kernel"));

  equal(legacyCalls, 2);
  equal(dshCalls, 0);
});

test("DSH controlled Run invokes exactly one DSH processor and never double-plans", async () => {
  let legacyCalls = 0;
  let dshCalls = 0;
  const legacy: AgentRunProcessor = { async process() { legacyCalls += 1; } };
  const dsh: AgentRunProcessor = { async process() { dshCalls += 1; } };

  await new SkillDispatchProcessor(legacy, unused, undefined, { controlledDsh: dsh })
    .process(controlledContext("dsh"));

  equal(legacyCalls, 0);
  equal(dshCalls, 1);
});

test("DSH controlled Run fails closed when its processor is not installed", async () => {
  await rejects(
    () => new SkillDispatchProcessor(unused, unused).process(controlledContext("dsh")),
    /agent_runtime_unavailable/,
  );
});

test("HTML remains pinned to its legacy runner during U4", async () => {
  const base = context();
  const htmlContext: AgentRunContext = {
    ...base,
    claimed: {
      ...base.claimed,
      run: {
        ...base.claimed.run,
        skillId: "bowerbird-html-layout-render",
        skillVersion: "0.1.0",
        agentRuntime: "dsh",
      },
    },
  };
  await rejects(
    () => new SkillDispatchProcessor(unused, unused).process(htmlContext),
    /agent_runtime_skill_mismatch/,
  );
});
