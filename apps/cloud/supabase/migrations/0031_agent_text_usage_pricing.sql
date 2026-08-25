-- A5-T1/T2: versioned Agent usage pricing and a minimum budget that includes
-- the bounded text-planning retries before one managed image generation.

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values (
  'agent_usage_v1',
  1,
  1,
  '{
    "billing":"agent_usage",
    "model_tokens":{"provider":"deepseek","input_tokens_per_credit":500000,"output_tokens_per_credit":100000,"minimum_credits":1},
    "vision_call":{"provider":"ark","credits_per_call":1},
    "image_generation":{"ark":5,"jimeng":0,"codex":0}
  }'::jsonb,
  true
)
on conflict (service) do update
set unit_cost = excluded.unit_cost,
    pricing_version = excluded.pricing_version,
    parameters = excluded.parameters,
    active = excluded.active;

update public.service_costs
set parameters = jsonb_set(parameters, '{usage_service}', '"agent_usage_v1"'::jsonb, true)
where service = 'agent_controlled_image_edit';

-- At most two intent turns plus two initial-plan turns can precede the first
-- image. Four minimum text credits + one 5-credit managed image = 9 credits.
update public.service_costs
set unit_cost = 9,
    parameters = jsonb_set(
      jsonb_set(parameters, '{max_budget_credits}', '9'::jsonb, true),
      '{usage_service}',
      '"agent_usage_v1"'::jsonb,
      true
    )
where service = 'agent_controlled_image_edit_min';

comment on table public.agent_usage_items is
  'Raw provider usage bound to durable tool calls; credits are calculated by the Edge control plane from immutable agent_usage_vN service_costs.';
