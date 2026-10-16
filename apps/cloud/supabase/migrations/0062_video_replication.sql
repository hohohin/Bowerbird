-- Reuse understand leases, ownership, idempotency and settlement.
-- Deliberately NO service_costs rows: both operations remain unpriced/disabled.
alter table public.understand_jobs drop constraint understand_jobs_operation_check;
alter table public.understand_jobs add constraint understand_jobs_operation_check
  check (operation in ('caption', 'autoname', 'classify', 'video-analysis', 'text-rewrite'));
