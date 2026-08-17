-- Cloud generation tiers become data-driven: service_costs.parameters carries the
-- desktop dropdown metadata. A row whose parameters contain "label" shows up in the
-- desktop provider menu (ordered by parameters.sort); rows without a label stay
-- billable but hidden (e.g. legacy image_sd still sent by older desktop builds).
-- Adding a future tier = one service_costs row (label + sort) + worker model env.
-- The jobs CHECK is relaxed to any image_* service so new tiers need no migration.

alter table public.generation_jobs
  drop constraint generation_jobs_service_check;

alter table public.generation_jobs
  add constraint generation_jobs_service_check
  check (service ~ '^image_[a-z0-9_]{1,40}$');

update public.service_costs
set parameters = parameters || '{"label":"Bowerbird Cloud Pro","sort":1}'::jsonb,
    updated_at = now()
where service = 'image_hd';

update public.service_costs
set parameters = parameters || '{"label":"Bowerbird Cloud Fast","sort":2}'::jsonb,
    updated_at = now()
where service = 'image_fast';

update public.service_costs
set parameters = parameters || '{"label":"Bowerbird Cloud Lite","sort":3}'::jsonb,
    updated_at = now()
where service = 'image_lite';

-- image_sd: legacy alias of image_lite (same model), kept active for older desktop
-- builds; no label so it never appears in the dynamic menu.
