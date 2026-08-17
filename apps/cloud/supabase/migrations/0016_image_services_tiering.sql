-- Cloud image generation tiers: service doubles as the model-routing key.
--   image_hd  = Seedream 5.0 Pro   (provider key "bowerbird-cloud")
--   image_sd  = Seedream 5.0        (provider key "bowerbird-cloud-standard")
--   image_lite = Seedream 5.0 Lite  (provider key "bowerbird-cloud-lite")
-- Introductory pricing: every image service costs 1 credit per image.

alter table public.generation_jobs
  drop constraint generation_jobs_service_check;

alter table public.generation_jobs
  add constraint generation_jobs_service_check
  check (service in ('image_sd', 'image_hd', 'image_lite'));

insert into public.service_costs (service, unit_cost, parameters) values
  ('image_lite', 1, '{}')
on conflict (service) do update set
  unit_cost = excluded.unit_cost,
  active = true,
  updated_at = now();

update public.service_costs
set unit_cost = 1,
    active = true,
    updated_at = now()
where service in ('image_sd', 'image_hd');
