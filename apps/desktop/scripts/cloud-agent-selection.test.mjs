import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROLLED_AGENT_SKILL,
  HTML_LAYOUT_AGENT_SKILL,
  activateCloudAgentSkill,
  cloudAgentSkill,
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
