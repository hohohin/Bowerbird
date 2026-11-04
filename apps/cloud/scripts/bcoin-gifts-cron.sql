-- Run as the database owner after 0078, with Supabase Cron (pg_cron) enabled.
-- https://supabase.com/docs/guides/cron/quickstart
-- Re-running replaces this named job; no HTTP endpoint or secret is required.
begin;
do $$ begin
  if to_regprocedure('public.issue_due_subscription_credit_grants_batch(integer)') is null then
    raise exception 'Apply 0078 before enabling the Bcoin gift scheduler';
  end if;
  if not exists(select 1 from pg_extension where extname='pg_cron') then
    raise exception 'Enable Supabase Cron (pg_cron) before running this script';
  end if;
end $$;
select cron.schedule(
  'bowerbird-pro-monthly-bcoin',
  '*/5 * * * *',
  'select public.issue_due_subscription_credit_grants_batch(100);'
);
commit;

-- Verify the job and its actual runs after deployment:
select jobid,jobname,schedule,active from cron.job
  where jobname='bowerbird-pro-monthly-bcoin';
select runid,status,return_message,start_time,end_time from cron.job_run_details
  where jobid in (select jobid from cron.job where jobname='bowerbird-pro-monthly-bcoin')
  order by start_time desc limit 5;
