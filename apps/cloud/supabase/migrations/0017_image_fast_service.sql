-- Seedream 5.0 Pro fast mode tier: same Pro model, `optimize_prompt_options: {"mode":"fast"}`.
--   image_fast = provider key "bowerbird-cloud-fast" (Pro + fast mode, lower latency)
-- Introductory pricing stays 1 credit per image like the other tiers.

alter table public.generation_jobs
  drop constraint generation_jobs_service_check;

alter table public.generation_jobs
  add constraint generation_jobs_service_check
  check (service in ('image_sd', 'image_hd', 'image_lite', 'image_fast'));

insert into public.service_costs (service, unit_cost, parameters) values
  ('image_fast', 1, '{"optimize_prompt_mode":"fast"}')
on conflict (service) do update set
  unit_cost = excluded.unit_cost,
  active = true,
  updated_at = now();
