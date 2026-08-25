import { assertEquals } from "jsr:@std/assert@1";
import { activeTier, CONTROLLED_IMAGE_EDIT_SKILL, policyFor } from "./feature-policy.ts";

Deno.test("agent policy is derived with the rest of the tier policy", () => {
  const free = policyFor("free");
  const pro = policyFor("pro");
  const studio = policyFor("studio");

  assertEquals(free.can_use_agent_runs, true);
  assertEquals(free.allowed_agent_skills, [CONTROLLED_IMAGE_EDIT_SKILL]);
  assertEquals(free.agent_budget_options, ["controlled-min", "controlled-standard"]);
  assertEquals([free.max_parallel_agent_runs, pro.max_parallel_agent_runs, studio.max_parallel_agent_runs], [1, 2, 4]);
  assertEquals(free.can_use_byo, false);
  assertEquals(pro.can_use_byo, true);
});

Deno.test("expired subscriptions fail closed to free policy", () => {
  assertEquals(activeTier({
    tier: "studio",
    status: "active",
    current_period_end: "2026-01-01T00:00:00.000Z",
  }, Date.parse("2026-01-02T00:00:00.000Z")), "free");
  assertEquals(activeTier({ tier: "pro", status: "active", current_period_end: null }), "pro");
});
