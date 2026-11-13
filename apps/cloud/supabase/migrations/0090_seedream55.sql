-- Deploy the worker with ARK_IMAGE_MODEL_55 before applying this migration.
-- New jobs reuse the Pro Bcoin tariff; existing services/holds are untouched.
insert into public.service_costs(service, unit_cost, active, pricing_version, parameters)
values
 ('image_seedream55',20,true,20261023,'{"currency":"Bcoin","extra_reference_cost":1,"output_size":"2K","label":"Seedream 5.5","sort":0}'::jsonb),
 ('image_seedream55_1k',10,true,20261023,'{"currency":"Bcoin","extra_reference_cost":1,"output_size":"1K","label":"Seedream 5.5 1K","sort":0.1}'::jsonb),
 ('image_seedream55_15k',10,true,20261023,'{"currency":"Bcoin","extra_reference_cost":1,"output_size":"1.5K","label":"Seedream 5.5 1.5K","sort":0.2}'::jsonb);
