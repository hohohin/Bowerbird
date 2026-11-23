-- Provision the independent catalog entry in a closed state.
insert into public.service_costs (service, unit_cost, pricing_version, active, parameters)
values ('library_video_analysis', 0, 20261123, false, '{"pricing_ready":false,"billing_unit":"source_hour"}')
on conflict (service) do nothing;
