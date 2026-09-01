import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";

import { UNIFIED_AGENT_PLANNING_INPUT_SCHEMA, validateUnifiedAgentPlanningInput } from "./schemas.ts";
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";

function visualProfile() {
  const payload = {
    schemaVersion: 1 as const,
    profileId: "profile-u3",
    version: 3,
    sourceScopeHash: "source-scope-u3",
    summary: "克制、留白、暖灰纸张质感",
    must: [{ category: "composition" as const, value: "大量留白", polarity: "must" as const }],
    prefer: [{ category: "palette" as const, value: "暖灰与深棕", polarity: "prefer" as const }],
    avoid: [{ category: "light" as const, value: "硬闪", polarity: "avoid" as const }],
    contentThemes: ["咖啡器具"],
  };
  return { ...payload, hash: sha256Hex(canonicalJson(payload)) };
}

test("legacy unified input freezes the safe HTML output default", () => {
  const input = validateUnifiedAgentPlanningInput({ schemaVersion: 1, goal: "  产品长图  " });
  equal(input.goal, "产品长图");
  deepEqual(input.htmlOutput, {
    viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 900, overlapCssPx: 0 },
    background: "opaque",
  });
  equal((UNIFIED_AGENT_PLANNING_INPUT_SCHEMA.required as readonly string[]).includes("htmlOutput"), false);
});

test("custom unified HTML output settings stay structured and normalize slice overlap", () => {
  const input = validateUnifiedAgentPlanningInput({
    schemaVersion: 1,
    goal: "产品长图",
    htmlOutput: {
      viewport: { widthCssPx: 1080, heightCssPx: 1920, deviceScaleFactor: 2 },
      capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1200 },
      background: "transparent",
    },
  });
  deepEqual(input.htmlOutput, {
    viewport: { widthCssPx: 1080, heightCssPx: 1920, deviceScaleFactor: 2 },
    capture: { mode: "full_page_and_slices", sliceHeightCssPx: 1200, overlapCssPx: 0 },
    background: "transparent",
  });
});

test("unified HTML output rejects unknown fields and out-of-range renderer settings", () => {
  throws(() => validateUnifiedAgentPlanningInput({
    schemaVersion: 1,
    goal: "产品长图",
    htmlOutput: {
      viewport: { widthCssPx: 2410, heightCssPx: 700, deviceScaleFactor: 1 },
      capture: { mode: "full_page" },
      background: "opaque",
    },
  }), /unified_agent_input_invalid:viewport_width/);
  throws(() => validateUnifiedAgentPlanningInput({
    schemaVersion: 1,
    goal: "产品长图",
    htmlOutput: {
      viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
      capture: { mode: "viewport" },
      background: "opaque",
      url: "https://example.com",
    },
  }), /unified_agent_input_invalid:output_settings_shape/);
});

test("slice-only fields cannot be attached to viewport or full-page capture", () => {
  throws(() => validateUnifiedAgentPlanningInput({
    schemaVersion: 1,
    goal: "产品长图",
    htmlOutput: {
      viewport: { widthCssPx: 900, heightCssPx: 700, deviceScaleFactor: 1 },
      capture: { mode: "full_page", sliceHeightCssPx: 900 },
      background: "opaque",
    },
  }), /unified_agent_input_invalid:slice_params_without_slice_mode/);
});

test("unified input freezes a hash-bound visual profile capsule", () => {
  const capsule = visualProfile();
  const input = validateUnifiedAgentPlanningInput({
    schemaVersion: 1,
    goal: "把产品图和文案排成长图",
    visualProfileCapsule: capsule,
  });
  deepEqual(input.visualProfileCapsule, capsule);
  equal(input.visualProfileCapsule?.hash, capsule.hash);
  equal((UNIFIED_AGENT_PLANNING_INPUT_SCHEMA.required as readonly string[]).includes("visualProfileCapsule"), false);
});

test("unified input rejects a tampered visual profile before checkpointing", () => {
  const capsule = visualProfile();
  capsule.summary = "篡改后的高饱和霓虹";
  throws(() => validateUnifiedAgentPlanningInput({
    schemaVersion: 1,
    goal: "产品长图",
    visualProfileCapsule: capsule,
  }), /unified_agent_visual_profile_invalid/);
});
