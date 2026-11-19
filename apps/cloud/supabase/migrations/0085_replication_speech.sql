-- Speech reuses understanding ownership, leases, idempotency and credit settlement.
-- Proposed fixed pilot price: 5 Bcoin per successful <=120.2s request.
-- DISABLED pending explicit pricing/deployment approval and provider configuration.
alter table public.understand_jobs drop constraint understand_jobs_operation_check;
alter table public.understand_jobs add constraint understand_jobs_operation_check
  check (operation in ('caption', 'autoname', 'classify', 'video-analysis', 'text-rewrite', 'speech-transcription'));

insert into public.service_costs (service, unit_cost, pricing_version, parameters, active)
values ('replication_speech_transcription', 5, 1,
  '{"pricing_ready":false,"temporary_price":true,"resource_id":"volc.bigasr.auc_turbo","max_seconds":120.2}', false)
on conflict (service) do nothing;
