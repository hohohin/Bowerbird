-- 暂时放宽 Agent 模式的预授权门控：余额不足 48 时不再直接拒绝，而是落到 5 积分低档。
-- 背景：免费档每日发放 30 分 < 48，等于免费用户被完全挡在 Agent 之外。
-- 实现：credit_hold 严格要求金额等于 service_costs.unit_cost（stale client estimate），
-- 因此用第二行低档 service 表示「最低预授权」，由 agent-run create 按当日可用余额选档：
--   可用 ≥ 48 → agent_controlled_image_edit（预授权 48，budget_credits 48，行为不变）
--   可用 ≥ 5  → agent_controlled_image_edit_min（预授权 5，budget_credits 5；
--               即梦 Run 实际结算 0 分不受影响；云端 Run 可完成单步生成，
--               多步计划会在预算上限处安全失败并按实际用量结算）
--   可用 < 5  → 维持 insufficient_credits（无法为任何云端生图预授权）
-- service 名不带 image 前缀，不会泄漏进桌面生图档位菜单（0018 label 过滤之外）。
-- 恢复原门控：agent-run create 移除低档回退分支即可（本行可保留或 inactive）。

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'agent_controlled_image_edit_min',
  5,
  1,
  '{"billing":"usage_items","max_budget_credits":5,"max_plan_steps":8,"max_generate_calls":8,"text_provider":"deepseek","image_provider":"ark","note":"low-balance fallback tier while the 48-credit gate is relaxed"}'::jsonb,
  true
)
on conflict (service) do update
set unit_cost = excluded.unit_cost,
    parameters = excluded.parameters,
    active = excluded.active;
