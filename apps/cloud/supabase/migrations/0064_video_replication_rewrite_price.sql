-- Independently enable text rewriting at the same temporary 3-credit price.
insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values ('replication_text_rewrite', 3, 1,
  '{"pricing_ready":true,"temporary_price":true,"model":"doubao-seed-2-0-mini-260428"}', true)
on conflict (service) do update set
  unit_cost = excluded.unit_cost,
  pricing_version = public.service_costs.pricing_version + 1,
  parameters = excluded.parameters,
  active = excluded.active,
  updated_at = now();
