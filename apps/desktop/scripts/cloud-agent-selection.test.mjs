import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLED_AGENT_SKILL,
  DSH_AGENT_RUNTIME,
  HTML_LAYOUT_AGENT_SKILL,
  LEGACY_AGENT_RUNTIME,
  UNIFIED_AGENT_SKILL,
  activateCloudAgentRuntime,
  activateCloudAgentRuntimeSelection,
  activateCloudAgentSkill,
  cloudAgentModeForSelection,
  cloudAgentSkill,
  runtimeForAgentSkill,
  runSkillForAgentRuntime,
  toggleCloudAgent,
} from "../src/lib/cloudAgentSelection.ts";

test("choosing HTML activates the HTML Agent selection", () => {
  const selection = activateCloudAgentSkill(HTML_LAYOUT_AGENT_SKILL);

  assert.equal(selection, HTML_LAYOUT_AGENT_SKILL);
  assert.equal(cloudAgentSkill(selection), HTML_LAYOUT_AGENT_SKILL);
});

test("turning Agent off clears the active skill instead of leaving stale HTML state", () => {
  assert.equal(toggleCloudAgent(HTML_LAYOUT_AGENT_SKILL), null);
  assert.equal(cloudAgentSkill(null), CONTROLLED_AGENT_SKILL);
});

test("turning Agent on defaults to controlled image generation", () => {
  assert.equal(toggleCloudAgent(null), CONTROLLED_AGENT_SKILL);
});

test("unknown skill values are rejected", () => {
  assert.throws(() => activateCloudAgentSkill("unknown-skill"), /Unsupported cloud Agent skill/);
});

test("a marked test account can explicitly select DSH", () => {
  assert.equal(activateCloudAgentRuntime(DSH_AGENT_RUNTIME, true), DSH_AGENT_RUNTIME);
});

test("choosing DSH while Agent is off atomically arms the unified Agent", () => {
  const next = activateCloudAgentRuntimeSelection(DSH_AGENT_RUNTIME, true, null);

  assert.deepEqual(next, {
    runtime: DSH_AGENT_RUNTIME,
    selection: CONTROLLED_AGENT_SKILL,
  });
  assert.equal(runSkillForAgentRuntime(next.runtime, cloudAgentSkill(next.selection), true), UNIFIED_AGENT_SKILL);
});

test("choosing Legacy does not silently turn an inactive Agent on", () => {
  assert.deepEqual(
    activateCloudAgentRuntimeSelection(LEGACY_AGENT_RUNTIME, true, null),
    { runtime: LEGACY_AGENT_RUNTIME, selection: null },
  );
});

test("a DSH runtime can never resolve to the direct-generation mode", () => {
  assert.equal(cloudAgentModeForSelection(null, DSH_AGENT_RUNTIME, true), true);
  assert.equal(cloudAgentModeForSelection(null, LEGACY_AGENT_RUNTIME, true), false);
  assert.equal(cloudAgentModeForSelection(CONTROLLED_AGENT_SKILL, LEGACY_AGENT_RUNTIME, true), true);
});

test("an unmarked account cannot activate DSH", () => {
  assert.throws(
    () => activateCloudAgentRuntime(DSH_AGENT_RUNTIME, false),
    /Unsupported cloud Agent runtime/,
  );
});

test("DSH is account-level and resolves every legacy selection to the unified Agent", () => {
  assert.equal(runtimeForAgentSkill(DSH_AGENT_RUNTIME, HTML_LAYOUT_AGENT_SKILL, true), DSH_AGENT_RUNTIME);
  assert.equal(runSkillForAgentRuntime(DSH_AGENT_RUNTIME, HTML_LAYOUT_AGENT_SKILL, true), UNIFIED_AGENT_SKILL);
  assert.equal(runSkillForAgentRuntime(DSH_AGENT_RUNTIME, CONTROLLED_AGENT_SKILL, true), UNIFIED_AGENT_SKILL);
});

test("unmarked accounts remain on their selected legacy skill", () => {
  assert.equal(runtimeForAgentSkill(DSH_AGENT_RUNTIME, CONTROLLED_AGENT_SKILL, false), LEGACY_AGENT_RUNTIME);
  assert.equal(runSkillForAgentRuntime(DSH_AGENT_RUNTIME, HTML_LAYOUT_AGENT_SKILL, false), HTML_LAYOUT_AGENT_SKILL);
});
