-- Temporary, independently priced video analysis. Text rewrite stays unpriced.
insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values ('replication_video_analysis', 3, 1,
  '{"pricing_ready":true,"temporary_price":true,"model":"doubao-seed-2-0-mini-260428"}', true)
on conflict (service) do update set
  unit_cost = excluded.unit_cost,
  pricing_version = public.service_costs.pricing_version + 1,
  parameters = excluded.parameters,
  active = excluded.active,
  updated_at = now();
