-- Test tasks grow their hold to the server-priced authorization instead of a fixed 30-credit cap.
-- No free credits or changes to public account pricing; the same hold settles actual usage.
create or replace function public.extend_agent_test_budget(
  p_run_id uuid, p_lease_id uuid, p_budget integer,
  p_cost_per_credit_micros bigint, p_daily_cost_limit_micros bigint
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  r public.agent_runs;
  h public.credit_holds;
  lot record;
  needed integer;
  take_amount integer;
  cost_delta bigint;
  daily_cost bigint;
  v_business_date date := timezone('Asia/Shanghai', now())::date;
begin
  select * into r from public.agent_runs where id = p_run_id for update;
  if r.id is null or r.skill_id <> 'bowerbird-unified-agent' or r.lease_id is distinct from p_lease_id
    or r.lease_expires_at <= now() or r.status <> 'running' then
    raise exception 'invalid agent test lease' using errcode = '55000';
  end if;
  if not exists (select 1 from public.billing_accounts b join auth.users u on u.id = b.auth_user_id
    where b.id = r.user_id and u.raw_app_meta_data->'bowerbird_test' = 'true'::jsonb) then
    raise exception 'test account required' using errcode = '42501';
  end if;
  if p_budget is null or p_budget < 1 or p_cost_per_credit_micros < 0 or p_daily_cost_limit_micros <= 0 then
    raise exception 'invalid test budget' using errcode = '22023';
  end if;
  if p_budget <= r.budget_credits then return r.budget_credits; end if;
  perform 1 from public.user_credits where user_id = r.user_id for update;
  select * into h from public.credit_holds where id = r.hold_id for update;
  if h.status <> 'held' or h.service <> 'agent_unified_test' or h.estimated_amount <> r.budget_credits then
    raise exception 'test hold mismatch' using errcode = '55000';
  end if;
  needed := p_budget - h.estimated_amount;
  for lot in select id, remaining_amount from public.credit_lots
    where user_id = r.user_id and remaining_amount > 0 and expires_at > now()
    order by case bucket when 'daily' then 0 when 'sub' then 1 else 2 end, expires_at, created_at, id for update
  loop
    exit when needed = 0;
    take_amount := least(needed, lot.remaining_amount);
    update public.credit_lots set remaining_amount = remaining_amount - take_amount where id = lot.id;
    insert into public.credit_hold_allocations (user_id, hold_id, lot_id, amount)
      values (r.user_id, h.id, lot.id, take_amount)
      on conflict (hold_id, lot_id) do update set amount = public.credit_hold_allocations.amount + excluded.amount;
    insert into public.credit_transactions (user_id, hold_id, lot_id, kind, amount, service)
      values (r.user_id, h.id, lot.id, 'hold', -take_amount, h.service);
    needed := needed - take_amount;
  end loop;
  if needed <> 0 then raise exception 'insufficient credits' using errcode = 'P0001', detail = 'insufficient_credits'; end if;
  cost_delta := (p_budget - h.estimated_amount)::bigint * p_cost_per_credit_micros;
  if cost_delta > p_daily_cost_limit_micros then raise exception 'daily cost limit' using detail = 'daily_cost_limit'; end if;
  insert into public.system_usage_daily as usage (business_date, request_count, cost_micros, updated_at)
    values (v_business_date, 0, cost_delta, now())
    on conflict (business_date) do update set cost_micros = usage.cost_micros + excluded.cost_micros, updated_at = now()
    where usage.cost_micros + excluded.cost_micros <= p_daily_cost_limit_micros
    returning cost_micros into daily_cost;
  if daily_cost is null then raise exception 'daily cost limit' using detail = 'daily_cost_limit'; end if;
  insert into public.usage_daily as usage (user_id, business_date, request_count, cost_micros)
    values (r.user_id, v_business_date, 0, cost_delta)
    on conflict (user_id, business_date) do update set cost_micros = usage.cost_micros + excluded.cost_micros;
  update public.credit_holds set estimated_amount = p_budget,
    reserved_cost_micros = coalesce(reserved_cost_micros, 0) + cost_delta, updated_at = now() where id = h.id;
  update public.agent_runs set budget_credits = p_budget where id = r.id;
  perform public.refresh_user_credit_snapshot(r.user_id);
  return p_budget;
end;
$$;
revoke all on function public.extend_agent_test_budget(uuid, uuid, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.extend_agent_test_budget(uuid, uuid, integer, bigint, bigint) to service_role;
