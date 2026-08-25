-- A5-T5: append one non-sensitive Agent Run marker to the credit ledger when
-- a Run becomes terminal. The generic hold/confirm/rollback rows remain the
-- monetary source of truth; this zero-amount marker makes the business entity
-- identifiable without storing prompts, images, object keys or model output.

create unique index credit_transactions_agent_run_marker_idx
  on public.credit_transactions (hold_id)
  where kind = 'adjust' and meta ->> 'entity_type' = 'agent_run';

create or replace function public.record_agent_run_billing_marker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  billing_service text;
begin
  if new.status not in ('succeeded', 'failed', 'cancelled')
      or old.status in ('succeeded', 'failed', 'cancelled')
      or new.actual_credits is null then
    return new;
  end if;

  select hold.service into billing_service
  from public.credit_holds as hold
  where hold.id = new.hold_id;

  insert into public.credit_transactions (
    user_id, hold_id, kind, amount, service, meta
  ) values (
    new.user_id,
    new.hold_id,
    'adjust',
    0,
    billing_service,
    jsonb_build_object(
      'entity_type', 'agent_run',
      'run_id', new.id,
      'skill_id', new.skill_id,
      'skill_version', new.skill_version,
      'final_status', new.status,
      'actual_credits', new.actual_credits,
      'pricing_version', new.pricing_version,
      'image_provider', new.image_provider
    )
  ) on conflict do nothing;
  return new;
end;
$$;

revoke execute on function public.record_agent_run_billing_marker()
  from public, anon, authenticated;

drop trigger if exists agent_runs_billing_marker on public.agent_runs;
create trigger agent_runs_billing_marker
after update of status, actual_credits on public.agent_runs
for each row execute function public.record_agent_run_billing_marker();

-- Historical terminal Runs receive the same technical marker once. This is a
-- ledger annotation only; it does not change balances or existing transactions.
insert into public.credit_transactions (
  user_id, hold_id, kind, amount, service, meta, created_at
)
select
  run.user_id,
  run.hold_id,
  'adjust',
  0,
  hold.service,
  jsonb_build_object(
    'entity_type', 'agent_run',
    'run_id', run.id,
    'skill_id', run.skill_id,
    'skill_version', run.skill_version,
    'final_status', run.status,
    'actual_credits', run.actual_credits,
    'pricing_version', run.pricing_version,
    'image_provider', run.image_provider
  ),
  coalesce(run.finished_at, now())
from public.agent_runs as run
join public.credit_holds as hold on hold.id = run.hold_id
where run.status in ('succeeded', 'failed', 'cancelled')
  and run.actual_credits is not null
on conflict do nothing;

comment on function public.record_agent_run_billing_marker() is
  'Adds one zero-amount, non-content Agent Run marker to the append-only credit ledger at terminal settlement.';
