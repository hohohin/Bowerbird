-- GPT Image 2.5 services use the existing durable Cloud image queue.
-- Prices are deliberately unset. Enable only after Worker/key deployment and
-- a reviewed per-image price for each model (quality=high, one PNG per job).
insert into public.service_costs(service, unit_cost, active, parameters) values
 ('image_gpt25_sunburst', 0, false, '{"label":"GPT Image 2.5 Sunburst","sort":4,"provider":"openai","model":"gpt-image-2.5-sunburst","quality":"high","pricing_ready":false}'),
 ('image_gpt25_flare', 0, false, '{"label":"GPT Image 2.5 Flare","sort":5,"provider":"openai","model":"gpt-image-2.5-flare","quality":"high","pricing_ready":false}')
on conflict(service) do nothing;

alter table public.service_costs add constraint gpt_image_pricing_activation_check check (
 service not in ('image_gpt25_sunburst','image_gpt25_flare') or not active
 or (unit_cost > 0 and parameters @> '{"pricing_ready":true}'::jsonb)
);
