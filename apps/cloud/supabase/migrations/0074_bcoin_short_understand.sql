update public.service_costs set unit_cost=1,pricing_version=20261023,
 parameters=parameters||'{"currency":"Bcoin","max_output_tokens":2000,"max_text_utf8_bytes":8000}'::jsonb,
 updated_at=now() where service='caption';
-- Long video/complex rewriting keep their independently bounded service price.
insert into public.service_costs(service,unit_cost,active,pricing_version,parameters)
 select 'replication_text_rewrite_short',1,active,20261023,
 parameters||'{"currency":"Bcoin","max_output_tokens":2000,"max_text_utf8_bytes":8000}'::jsonb
 from public.service_costs where service='replication_text_rewrite';
