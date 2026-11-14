-- Apply atomically. Only new controlled direct DeepSeek calls opt into this contract.
alter table public.agent_tool_calls
  add column direct_deepseek_v1_model text check (char_length(direct_deepseek_v1_model) between 1 and 120 and tool_name='model_turn'),
  add column model_write_lease uuid,
  add column pending_model_usage jsonb,
  add column model_review_ref text check (char_length(model_review_ref) between 1 and 160);
alter table public.agent_usage_items add column model_write_lease uuid;
-- Write-only lease witnesses are cleared by the triggers before the row is stored.

create function public.guard_agent_direct_model_call() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs;
begin
  if tg_op='UPDATE' and new.direct_deepseek_v1_model is distinct from old.direct_deepseek_v1_model
     and not (old.direct_deepseek_v1_model is null and old.status='prepared' and new.status='prepared'
              and (new.run_id,new.call_id,new.tool_name,new.phase,new.args_hash) =
                  (old.run_id,old.call_id,old.tool_name,old.phase,old.args_hash)) then
    raise exception 'immutable direct model contract';
  end if;
  if new.direct_deepseek_v1_model is null then
    if new.pending_model_usage is not null then raise exception 'unexpected direct model observation'; end if;
    return new;
  end if;
  select * into strict r from public.agent_runs where id=new.run_id for update;
  if r.agent_runtime <> 'legacy_kernel' or r.skill_id not in ('bowerbird-controlled-image-edit','bowerbird-html-layout-render')
     or r.lease_id is null or r.lease_id is distinct from new.model_write_lease or r.lease_expires_at <= clock_timestamp()
     or r.status in ('succeeded','failed','cancelled') then
    raise exception 'invalid direct model lease or runtime' using errcode='55000';
  end if;
  new.model_write_lease := null;
  if tg_op='INSERT' and new.status <> 'prepared' then raise exception 'missing direct model preparation'; end if;
  if new.pending_model_usage is not null then
    if new.status not in ('outcome_unknown','succeeded') or (new.status='outcome_unknown'
       and new.safe_error_code not in ('agent_model_usage_pending','agent_model_minimum_pending')) then raise exception 'invalid observation state'; end if;
    if jsonb_typeof(new.pending_model_usage)<>'object' or new.pending_model_usage - 'inputUnits' - 'outputUnits' <> '{}'::jsonb
       or not (new.pending_model_usage ?& array['inputUnits','outputUnits'])
       or not (new.pending_model_usage->>'inputUnits' ~ '^[0-9]{1,8}$' and new.pending_model_usage->>'outputUnits' ~ '^[0-9]{1,8}$')
       or jsonb_typeof(new.pending_model_usage->'inputUnits') <> 'number' or jsonb_typeof(new.pending_model_usage->'outputUnits') <> 'number'
       or (new.pending_model_usage->>'inputUnits')::int > 10000000 or (new.pending_model_usage->>'outputUnits')::int > 10000000
    then raise exception 'invalid direct model usage observation'; end if;
  end if;
  if tg_op='UPDATE' and old.pending_model_usage is not null and old.pending_model_usage is distinct from new.pending_model_usage then
    raise exception 'conflicting direct model usage observation';
  end if;
  if tg_op='UPDATE' and old.status='prepared' and new.status='submitted' then
    if (public.mark_hold_pending_settlement(r.hold_id,'agent model submitted')).status <> 'pending_settlement' then
      raise exception 'direct model hold unavailable' using errcode='55000';
    end if;
  end if;
  return new;
end $$;
create trigger guard_agent_direct_model before insert or update of status,provider_request_id,pending_model_usage,direct_deepseek_v1_model
on public.agent_tool_calls for each row execute function public.guard_agent_direct_model_call();

-- The historical budget guard already locks the run; use the same lock order everywhere.
create function public.guard_agent_direct_model_usage() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs; c public.agent_tool_calls;
begin
  select * into c from public.agent_tool_calls where run_id=new.run_id and call_id=new.call_id;
  if c.direct_deepseek_v1_model is not null then
    select * into strict r from public.agent_runs where id=new.run_id for update;
    select * into strict c from public.agent_tool_calls where run_id=new.run_id and call_id=new.call_id;
    if new.kind<>'model_tokens' or new.provider<>'deepseek' or new.model<>c.direct_deepseek_v1_model or new.pricing_version<>r.pricing_version
       or new.image_count<>0 or c.status='prepared' or (c.status='failed' and c.safe_error_code in ('deepseek_http_error','deepseek_not_dispatched'))
       or (c.pending_model_usage is not null and c.pending_model_usage <> jsonb_build_object('inputUnits',new.input_units,'outputUnits',new.output_units)
           and not (c.model_review_ref is not null and c.safe_error_code='agent_model_minimum_pending')) then
      raise exception 'invalid direct model usage identity' using errcode='55000';
    end if;
    if r.status in ('failed','succeeded','cancelled') then
      if r.actual_credits is not null or new.model_write_lease is not null or c.model_review_ref is null then
        raise exception 'direct model is closed for worker writes' using errcode='55000';
      end if;
    elsif new.model_write_lease is null or new.model_write_lease is distinct from r.lease_id or r.lease_expires_at <= clock_timestamp() then
      raise exception 'invalid direct model usage lease' using errcode='55000';
    end if;
  end if;
  new.model_write_lease := null;
  return new;
end $$;
create trigger guard_agent_direct_model_usage before insert on public.agent_usage_items
for each row execute function public.guard_agent_direct_model_usage();

-- Called with the agent_runs row locked. Unknown outcome is neither a payment nor a refund.
create function public.settle_complete_agent_usage(r public.agent_runs, reason text) returns integer
language plpgsql security definer set search_path='' as $$
declare actual integer;
begin
  if exists(select 1 from public.agent_tool_calls c where c.run_id=r.id and c.direct_deepseek_v1_model is not null
      and c.status<>'prepared' and not (c.status='failed' and coalesce(c.safe_error_code,'') in ('deepseek_http_error','deepseek_not_dispatched'))
      and c.model_review_ref is null and not exists(select from public.agent_usage_items u where u.run_id=c.run_id and u.call_id=c.call_id)) then
    if (public.mark_hold_pending_settlement(r.hold_id,'agent model usage pending')).status <> 'pending_settlement' then
      raise exception 'agent model hold is unavailable';
    end if;
    return null;
  end if;
  select coalesce(sum(credits),0) into actual from public.agent_usage_items where run_id=r.id;
  if actual<0 or actual>r.budget_credits then raise exception 'agent usage exceeds budget' using errcode='55000'; end if;
  if actual>0 then perform public.credit_confirm(r.hold_id,actual);
  else perform public.credit_rollback(r.hold_id,reason); end if;
  return actual;
end $$;

-- Operator reconciliation via the existing service role. A saved observation can be replayed
-- without provider access. Other dispositions require a verified external receipt/reference.
create function public.reconcile_agent_model_usage(p_run_id uuid,p_call_id text,p_evidence_ref text,
    p_action text,p_input_units integer default null,p_output_units integer default null) returns integer
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs; c public.agent_tool_calls; u public.agent_usage_items;
  units jsonb; rates jsonb; model_rate jsonb; cost_rate jsonb; amount int; cost bigint;
begin
  select * into strict r from public.agent_runs where id=p_run_id for update;
  select * into strict c from public.agent_tool_calls where run_id=r.id and call_id=p_call_id;
  if c.direct_deepseek_v1_model is null or r.status not in ('succeeded','failed','cancelled') or c.status='prepared'
     or (c.status='failed' and c.safe_error_code in ('deepseek_http_error','deepseek_not_dispatched'))
     or p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9_./:-]{1,160}$' then raise exception 'invalid direct model review'; end if;
  select * into u from public.agent_usage_items where run_id=r.id and call_id=p_call_id;
  if p_action='recorded' then
    if c.pending_model_usage is null or p_input_units is not null or p_output_units is not null then raise exception 'missing saved observation'; end if;
    units := c.pending_model_usage;
  elsif p_action='receipt' and p_input_units between 0 and 10000000 and p_output_units between 0 and 10000000 then
    units := jsonb_build_object('inputUnits',p_input_units,'outputUnits',p_output_units);
  elsif p_action='no_charge' and p_input_units is null and p_output_units is null then
    units := null;
  else raise exception 'invalid direct model review disposition'; end if;
  if c.pending_model_usage is not null and units is distinct from c.pending_model_usage
     and not (c.safe_error_code='agent_model_minimum_pending' and p_action in ('receipt','no_charge')) then raise exception 'conflicting saved observation'; end if;
  if u.id is not null and (units is null or units<>jsonb_build_object('inputUnits',u.input_units,'outputUnits',u.output_units)) then
    raise exception 'conflicting posted model usage'; end if;
  if c.model_review_ref is not null and (c.model_review_ref <> p_evidence_ref or (u.id is null) <> (units is null)) then
    raise exception 'conflicting model review'; end if;
  if r.actual_credits is not null then
    if c.model_review_ref is null and u.id is null then raise exception 'model review already closed'; end if;
    return r.actual_credits;
  end if;
  if (select status from public.credit_holds where id=r.hold_id) is distinct from 'pending_settlement' then raise exception 'model hold not pending'; end if;
  update public.agent_tool_calls set model_review_ref=p_evidence_ref where run_id=r.id and call_id=p_call_id;
  if units is not null and u.id is null then
    select parameters into strict rates from public.service_costs where service='agent_usage_v'||r.pricing_version and pricing_version=r.pricing_version;
    model_rate := rates->'model_tokens'; cost_rate := rates->'provider_cost';
    if rates->>'billing' is distinct from 'agent_usage' or model_rate->>'provider' is distinct from 'deepseek'
       or coalesce((model_rate->>'minimum_credits')::int,0)<1 or coalesce((model_rate->>'input_tokens_per_credit')::int,0)<1
       or coalesce((model_rate->>'output_tokens_per_credit')::int,0)<1 then raise exception 'invalid historical usage pricing'; end if;
    p_input_units := (units->>'inputUnits')::int; p_output_units := (units->>'outputUnits')::int;
    amount := greatest((model_rate->>'minimum_credits')::int,
      ceil(p_input_units::float8/(model_rate->>'input_tokens_per_credit')::int + p_output_units::float8/(model_rate->>'output_tokens_per_credit')::int)::int);
    if cost_rate is not null and cost_rate <> 'null'::jsonb then
      if cost_rate->>'currency' is distinct from 'CNY' or coalesce((cost_rate->>'deepseek_input_micros_per_million_tokens')::bigint,-1)<0
        or coalesce((cost_rate->>'deepseek_output_micros_per_million_tokens')::bigint,-1)<0 then raise exception 'invalid historical provider pricing'; end if;
      cost := ceil((p_input_units::numeric*(cost_rate->>'deepseek_input_micros_per_million_tokens')::bigint+
                    p_output_units::numeric*(cost_rate->>'deepseek_output_micros_per_million_tokens')::bigint)/1000000);
    end if;
    insert into public.agent_usage_items(run_id,call_id,kind,provider,model,input_units,output_units,credits,pricing_version,provider_cost_micros)
    values(r.id,p_call_id,'model_tokens','deepseek',c.direct_deepseek_v1_model,p_input_units,p_output_units,amount,r.pricing_version,cost);
  end if;
  amount := public.settle_complete_agent_usage(r,'agent run '||r.status||' without usage');
  update public.agent_runs set actual_credits=amount where id=r.id;
  return amount;
end $$;
revoke all on function public.guard_agent_direct_model_call(),public.guard_agent_direct_model_usage(),
  public.settle_complete_agent_usage(public.agent_runs,text),public.reconcile_agent_model_usage(uuid,text,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.reconcile_agent_model_usage(uuid,text,text,text,integer,integer) to service_role;

create or replace function public.settle_agent_run(
  p_run_id uuid,
  p_lease_id uuid,
  p_final_status text,
  p_error_code text default null,
  p_safe_message text default null
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
  settled public.agent_runs;
  actual integer;
  final_count integer;
  html_primary_count integer;
begin
  if p_final_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid agent final status' using errcode = '22023';
  end if;
  if p_error_code is not null and char_length(p_error_code) > 80 then
    raise exception 'agent error code too long' using errcode = '22023';
  end if;
  if p_safe_message is not null and char_length(p_safe_message) > 500 then
    raise exception 'agent safe message too long' using errcode = '22023';
  end if;

  select run.* into locked
  from public.agent_runs as run
  where run.id = p_run_id
  for update;
  if not found then
    raise exception 'unknown agent run' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() then
    raise exception 'invalid or expired agent lease' using errcode = '55000';
  end if;
  if not public.agent_run_transition_allowed(locked.status, p_final_status) then
    raise exception 'invalid agent run transition: % -> %', locked.status, p_final_status
      using errcode = '55000';
  end if;

  if p_final_status = 'succeeded' then
    select
      (count(*) filter (where artifact.role = 'final_result'))::integer,
      (count(*) filter (
        where artifact.role in ('viewport_screenshot', 'full_page_screenshot')
      ))::integer
    into final_count, html_primary_count
    from public.agent_artifacts as artifact
    where artifact.run_id = p_run_id
      and artifact.deleted_at is null;

    if locked.skill_id = 'bowerbird-html-layout-render' then
      if html_primary_count <> 1 then
        raise exception 'succeeded agent run requires exactly one primary result'
          using errcode = '55000';
      end if;
    elsif locked.skill_id = 'bowerbird-unified-agent' then
      if final_count < 1 and html_primary_count < 1 and not (
        locked.approved_plan_hash is null
        and exists (select 1 from public.agent_events e
          where e.run_id = p_run_id and e.seq = 10 and e.type = 'text.rewrite.started')
        and exists (select 1 from public.agent_events e
          where e.run_id = p_run_id and e.seq = 90 and e.type = 'text.result'
            and e.display_payload->'schemaVersion' = '1'::jsonb
            and jsonb_typeof(e.display_payload->'text') = 'string'
            and length(btrim(e.display_payload->>'text')) > 0
            and e.display_payload - 'schemaVersion' - 'text' = '{}'::jsonb)
      ) then
        raise exception 'succeeded unified agent run requires at least one result'
          using errcode = '55000';
      end if;
    elsif final_count <> 1 then
      raise exception 'succeeded agent run requires exactly one primary result'
        using errcode = '55000';
    end if;
  end if;

  actual := public.settle_complete_agent_usage(locked, 'agent run ' || p_final_status || ' without usage');

  update public.agent_runs as run
  set status = p_final_status,
      current_step = case when p_final_status = 'succeeded' then 'done' else coalesce(p_error_code, p_final_status) end,
      progress = case when p_final_status = 'succeeded' then 100 else run.progress end,
      actual_credits = actual,
      approval_required = false,
      error_code = case when p_final_status = 'failed' then p_error_code else null end,
      safe_message = case when p_final_status = 'failed' then p_safe_message else null end,
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null,
      finished_at = now()
  where run.id = p_run_id
  returning run.* into settled;

  return settled;
end;
$$;

create or replace function public.cancel_unleased_agent_run(p_run_id uuid)
returns table(status text, actual_credits integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.agent_runs%rowtype;
  v_actual integer;
begin
  select * into v_run
  from public.agent_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'agent_run_not_found';
  end if;
  if v_run.status in ('succeeded', 'failed', 'cancelled') then
    return query select v_run.status, v_run.actual_credits;
    return;
  end if;
  if v_run.status not in (
      'uploading', 'queued', 'awaiting_clarification', 'awaiting_approval',
      'awaiting_result_feedback', 'awaiting_local_task'
    ) or v_run.lease_id is not null then
    raise exception 'agent_run_not_unleased';
  end if;

  v_actual := public.settle_complete_agent_usage(v_run, null);

  update public.agent_runs
  set status = 'cancelled',
      actual_credits = v_actual,
      cancel_requested_at = coalesce(cancel_requested_at, now()),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null,
      heartbeat_at = null
  where id = p_run_id;

  update public.agent_approvals
  set status = 'expired',
      decided_at = now()
  where run_id = p_run_id
    and agent_approvals.status = 'pending';

  return query select 'cancelled'::text, v_actual;
end;
$$;

create or replace function public.fail_unleased_agent_run(
  p_run_id uuid,
  p_error_code text,
  p_safe_message text
)
returns table(status text, actual_credits integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.agent_runs%rowtype;
  v_actual integer;
begin
  if p_error_code is null or btrim(p_error_code) = '' or char_length(p_error_code) > 80 then
    raise exception 'agent_error_code_invalid';
  end if;
  if p_safe_message is not null and char_length(p_safe_message) > 500 then
    raise exception 'agent_safe_message_invalid';
  end if;

  select * into v_run
  from public.agent_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'agent_run_not_found';
  end if;
  if v_run.status in ('succeeded', 'failed', 'cancelled') then
    return query select v_run.status, v_run.actual_credits;
    return;
  end if;
  if v_run.status <> 'awaiting_local_task' or v_run.lease_id is not null then
    raise exception 'agent_run_not_awaiting_local_task';
  end if;

  v_actual := public.settle_complete_agent_usage(v_run, null);

  update public.agent_runs
  set status = 'failed',
      actual_credits = v_actual,
      error_code = p_error_code,
      safe_message = coalesce(p_safe_message, ''),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null,
      heartbeat_at = null
  where id = p_run_id;

  return query select 'failed'::text, v_actual;
end;
$$;

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
      or (old.status in ('succeeded', 'failed', 'cancelled') and old.actual_credits is not null)
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

create or replace function public.claim_agent_run(
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns public.agent_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_id uuid;
  claimed public.agent_runs;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or char_length(p_worker_id) > 120 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 15 and 300' using errcode = '22023';
  end if;

  perform public.expire_stale_local_tasks();

  -- A cancelled, expired direct-model lease is deliberately excluded from ordinary claims.
  -- Finish one such run without returning it for model execution. The same settlement
  -- transaction keeps missing usage pending for review. Other queued work still proceeds.
  select r.* into claimed from public.agent_runs r
  where r.cancel_requested_at is not null and r.lease_expires_at <= now()
    and r.status in ('leased','running','exporting','cancel_requested')
    and exists(select from public.agent_tool_calls c where c.run_id=r.id and c.direct_deepseek_v1_model is not null)
  order by r.lease_expires_at,r.id for update skip locked limit 1;
  if found then
    update public.agent_runs set lease_id=extensions.gen_random_uuid(), lease_owner=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds) where id=claimed.id returning * into claimed;
    perform public.settle_agent_run(claimed.id,claimed.lease_id,'cancelled');
  end if;

  select run.id into candidate_id
  from public.agent_runs as run
  where run.cancel_requested_at is null
    and (
      run.status = 'queued'
      or (run.status in ('leased', 'running', 'exporting') and run.lease_expires_at <= now())
    )
  order by coalesce(run.queued_at, run.created_at), run.created_at, run.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.agent_runs as run
  set status = 'leased',
      lease_id = extensions.gen_random_uuid(),
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      attempt_count = run.attempt_count + 1,
      started_at = coalesce(run.started_at, now())
  where run.id = candidate_id
  returning run.* into claimed;

  return claimed;
end;
$$;

create or replace function public.transition_agent_run(
  p_run_id uuid,
  p_lease_id uuid,
  p_to_status text,
  p_current_step text default null,
  p_progress integer default null,
  p_checkpoint_object_key text default null,
  p_checkpoint_hash text default null,
  p_snapshot_schema_version integer default null
)
returns public.agent_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.agent_runs;
  transitioned public.agent_runs;
  releases_lease boolean;
begin
  if p_progress is not null and (p_progress < 0 or p_progress > 100) then
    raise exception 'progress must be between 0 and 100' using errcode = '22023';
  end if;
  if p_checkpoint_hash is not null and p_checkpoint_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid checkpoint hash' using errcode = '22023';
  end if;

  select run.* into locked
  from public.agent_runs as run
  where run.id = p_run_id
  for update;
  if not found then
    raise exception 'unknown agent run' using errcode = 'P0002';
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now() then
    raise exception 'invalid or expired agent lease' using errcode = '55000';
  end if;
  if p_to_status in ('succeeded','failed','cancelled') and exists (
      select from public.agent_tool_calls c where c.run_id=locked.id and c.direct_deepseek_v1_model is not null
  ) then
    raise exception 'direct model terminal transitions require settlement' using errcode='55000';
  end if;
  if not public.agent_run_transition_allowed(locked.status, p_to_status) then
    raise exception 'invalid agent run transition: % -> %', locked.status, p_to_status using errcode = '55000';
  end if;

  releases_lease := p_to_status not in ('leased', 'running', 'exporting', 'cancel_requested');
  update public.agent_runs as run
  set status = p_to_status,
      current_step = coalesce(p_current_step, run.current_step),
      progress = coalesce(p_progress, run.progress),
      checkpoint_object_key = coalesce(p_checkpoint_object_key, run.checkpoint_object_key),
      checkpoint_hash = coalesce(p_checkpoint_hash, run.checkpoint_hash),
      snapshot_schema_version = coalesce(p_snapshot_schema_version, run.snapshot_schema_version),
      lease_id = case when releases_lease then null else run.lease_id end,
      lease_owner = case when releases_lease then null else run.lease_owner end,
      lease_expires_at = case when releases_lease then null else run.lease_expires_at end,
      heartbeat_at = case when releases_lease then run.heartbeat_at else now() end,
      finished_at = case when p_to_status in ('cancelled', 'succeeded', 'failed') then now() else run.finished_at end
  where run.id = p_run_id
  returning run.* into transitioned;

  return transitioned;
end;
$$;
