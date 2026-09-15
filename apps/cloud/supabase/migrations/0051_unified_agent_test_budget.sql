-- 0051 — 通用 DSH Agent 的 test-only 预算档（UNIFIED-AGENT-HARNESS U6）
-- 预算覆盖 DeepSeek 规划/检查与一次受控生图；实际费用仍只按可信 usage_items 结算。
-- FeaturePolicy 与 Edge 双重限制 bowerbird_test，且需显式 AGENT_UNIFIED_DSH_ENABLED=true。

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'agent_unified_test',
  30,
  1,
  '{"billing":"usage_items","max_budget_credits":30,"max_model_turns":8,"max_generate_calls":2,"max_render_calls":2,"planning_provider":"deepseek","image_provider":"ark_seedream","render_provider":"renderer","note":"unified DSH Agent test-only tier"}'::jsonb,
  true
)
on conflict (service) do update
set unit_cost = excluded.unit_cost,
    parameters = excluded.parameters,
    active = excluded.active;
