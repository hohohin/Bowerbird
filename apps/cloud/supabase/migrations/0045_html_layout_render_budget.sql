-- 0045 — HTML 离线排版 Skill 的预算档（HTML-RENDER-PLAN H3-T6）
-- agent-run 入队按 service_costs 预授权：agent_html_layout_render = 15 积分
-- （渲染本身 0 积分，H2 的 html_render usage 固定 0；额度覆盖 DeepSeek 文本回合）。
-- POC 期仅 bowerbird_test 标记账号可见（_shared/feature-policy.ts），不进公开档位。

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'agent_html_layout_render',
  15,
  1,
  '{"billing":"usage_items","max_budget_credits":15,"max_render_calls":1,"text_provider":"deepseek","render_provider":"renderer","note":"html layout render POC tier (test-only)"}'::jsonb,
  true
)
on conflict (service) do update
set unit_cost = excluded.unit_cost,
    parameters = excluded.parameters,
    active = excluded.active;
