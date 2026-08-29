import { assertEquals } from "jsr:@std/assert@1";
import {
  accountTestMarker,
  activeTier,
  agentAccessTestOnly,
  CONTROLLED_IMAGE_EDIT_SKILL,
  HTML_LAYOUT_RENDER_SKILL,
  policyFor,
  policyForUser,
} from "./feature-policy.ts";

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

Deno.test("A8 test-only access mode hides agent capability for unmarked accounts only", () => {
  assertEquals(agentAccessTestOnly("test_only"), true);
  assertEquals(agentAccessTestOnly("all"), false);
  assertEquals(agentAccessTestOnly("  TEST_ONLY "), true);
  assertEquals(agentAccessTestOnly(undefined), false);
  assertEquals(accountTestMarker({ bowerbird_test: true }), true);
  assertEquals(accountTestMarker({ bowerbird_test: "true" }), false);
  assertEquals(accountTestMarker(null), false);
  assertEquals(accountTestMarker([true]), false);

  const unmarked = policyForUser("pro", { app_metadata: {} }, { agentTestOnly: true });
  assertEquals(unmarked.can_use_agent_runs, false);
  assertEquals(unmarked.allowed_agent_skills, []);
  assertEquals(unmarked.agent_budget_options, []);
  // 非 Agent 能力不受门控影响。
  assertEquals(unmarked.can_use_byo, policyFor("pro").can_use_byo);

  const marked = policyForUser("free", { app_metadata: { bowerbird_test: true } }, { agentTestOnly: true });
  assertEquals(marked.can_use_agent_runs, true);
  assertEquals(marked.allowed_agent_skills, [CONTROLLED_IMAGE_EDIT_SKILL, HTML_LAYOUT_RENDER_SKILL]);

  const openMode = policyForUser("free", { app_metadata: {} }, { agentTestOnly: false });
  assertEquals(openMode.can_use_agent_runs, true);
  assertEquals(openMode.allowed_agent_skills, [CONTROLLED_IMAGE_EDIT_SKILL]);
});

Deno.test("H3 HTML layout skill is visible only to bowerbird_test accounts (POC test-only)", () => {
  // 未标记账号：无论小名单模式与否，都看不到 HTML 排版 Skill。
  const unmarkedOpen = policyForUser("pro", { app_metadata: {} }, { agentTestOnly: false });
  assertEquals(unmarkedOpen.allowed_agent_skills.includes(HTML_LAYOUT_RENDER_SKILL), false);
  // 标记账号：全量与小名单模式都追加 HTML 排版 Skill。
  const markedOpen = policyForUser("pro", { app_metadata: { bowerbird_test: true } }, { agentTestOnly: false });
  assertEquals(markedOpen.allowed_agent_skills.includes(HTML_LAYOUT_RENDER_SKILL), true);
  // 档位本身（policyFor）不包含 HTML Skill——只有用户级策略按标记追加。
  assertEquals(policyFor("pro").allowed_agent_skills.includes(HTML_LAYOUT_RENDER_SKILL), false);
});
