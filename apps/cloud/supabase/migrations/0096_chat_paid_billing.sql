-- Closed by default. These separate services reuse the wallet's fixed estimate
-- reservation. A later release must configure and approve each positive cap.
insert into public.service_costs(service,unit_cost,pricing_version,active,parameters) values
  ('chat_paid_flash_v1',0,20261121,false,'{"currency":"Bcoin","cache_hit":1280,"cache_miss":64000,"output":256000,"provider_models":["deepseek-flash","deepseek-v4.1-flash-1017"]}'),
  ('chat_paid_pro_v1',0,20261121,false,'{"currency":"Bcoin","cache_hit":9600,"cache_miss":288000,"output":864000,"provider_models":["deepseek-v4-pro","deepseek-v4-pro-0813"]}');

-- Public catalog reads keep their existing rows. Paid DSH contracts are
-- delivered by the explicit quote RPC, which does not expose the alias list.
alter policy service_costs_select_active on public.service_costs
using (active and service not in ('chat_paid_flash_v1','chat_paid_pro_v1'));

alter table public.chat_completion_jobs add column paid_billing jsonb, add column paid_reconcile_after timestamptz;

create table public.chat_paid_accounts (
  user_id uuid primary key references public.billing_accounts(id),
  carry_nano bigint not null default 0 check (carry_nano between 0 and 999999999)
);
create table public.chat_paid_call_limits (
  job_id uuid not null,
  call_id text not null,
  max_output_tokens integer not null check (max_output_tokens between 1 and 393216),
  risk_nano bigint not null check (risk_nano > 0),
  primary key(job_id,call_id),
  foreign key(job_id,call_id) references public.chat_model_calls(job_id,call_id) on delete cascade deferrable initially deferred
);
create table public.chat_paid_receipts (
  job_id uuid primary key references public.chat_completion_jobs(id),
  seq bigint generated always as identity unique,
  user_id uuid not null references public.billing_accounts(id),
  fee_nano bigint not null check (fee_nano >= 0),
  debited_credits integer not null check (debited_credits >= 0),
  carry_nano bigint not null check (carry_nano between 0 and 999999999),
  refunded_credits integer check (refunded_credits >= 0),
  refund_carry_nano bigint check (refund_carry_nano between 0 and 999999999),
  refund_reference text,
  check ((refunded_credits is null)=(refund_reference is null) and (refunded_credits is null)=(refund_carry_nano is null))
);
create index chat_paid_receipts_user_seq on public.chat_paid_receipts(user_id,seq desc);
alter table public.chat_paid_accounts enable row level security;
alter table public.chat_paid_accounts force row level security;
alter table public.chat_paid_call_limits enable row level security;
alter table public.chat_paid_call_limits force row level security;
alter table public.chat_paid_receipts enable row level security;
alter table public.chat_paid_receipts force row level security;
revoke all on public.chat_paid_accounts,public.chat_paid_call_limits,public.chat_paid_receipts from public,anon,authenticated,service_role;

create function public.chat_paid_provider_model_family(p_alias text) returns text
language sql immutable strict set search_path='' as $$
  select case
    when char_length(p_alias)>120 then null
    when lower(p_alias)='deepseek-flash' or lower(p_alias) ~ '^deepseek-v4(\.[0-9]+)?-flash(-[0-9]{4,8})?$' then 'deepseek-flash'
    when lower(p_alias) ~ '^deepseek-v4(\.[0-9]+)?-pro(-[0-9]{4,8})?$' then 'deepseek-v4-pro'
  end
$$;

create function public.quote_chat_paid_turn(p_model text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  price public.service_costs;
  output_cap integer;
  provider_models jsonb;
  rates jsonb;
  risk bigint;
begin
  if p_model is null or p_model not in ('deepseek-flash','deepseek-v4-pro') then
    raise exception 'invalid paid chat model' using errcode='22023';
  end if;
  select * into price from public.service_costs where service=case p_model
    when 'deepseek-flash' then 'chat_paid_flash_v1' else 'chat_paid_pro_v1' end;
  if not found or not price.active or price.unit_cost <= 0 or price.pricing_version <> 20261121
    or to_regclass('public.system_chat_usage_daily') is null
    or coalesce(price.parameters->>'max_output_tokens','') !~ '^[1-9][0-9]{0,5}$' then
    return jsonb_build_object('available',false,'model',p_model);
  end if;
  provider_models := price.parameters->'provider_models';
  if jsonb_typeof(provider_models) is distinct from 'array' then
    return jsonb_build_object('available',false,'model',p_model);
  end if;
  if jsonb_array_length(provider_models)=0 or exists(
    select 1 from jsonb_array_elements(provider_models) as a(alias)
    where jsonb_typeof(a.alias) is distinct from 'string'
      or public.chat_paid_provider_model_family(a.alias#>>'{}') is distinct from p_model
  ) then
    return jsonb_build_object('available',false,'model',p_model);
  end if;
  output_cap := (price.parameters->>'max_output_tokens')::integer;
  rates := case p_model when 'deepseek-flash' then '{"cache_hit":1280,"cache_miss":64000,"output":256000}'::jsonb
    else '{"cache_hit":9600,"cache_miss":288000,"output":864000}'::jsonb end;
  risk := 1048576 * (rates->>'cache_miss')::bigint + output_cap * ((rates->>'output')::bigint - (rates->>'cache_miss')::bigint);
  if output_cap > 393216 or risk > price.unit_cost::bigint * 1000000000 then
    return jsonb_build_object('available',false,'model',p_model);
  end if;
  return jsonb_build_object('available',true,'model',p_model,'pricing_version',price.pricing_version,
    'max_credits',price.unit_cost,'max_output_tokens',output_cap,'rates_nano',rates,'service',price.service);
end $$;

-- The approved hosted route has a shared 1,048,576-token context. Keep the
-- raw observation even when the supplier violates its advertised envelope.
create function public.chat_paid_rated_nano(p_billing jsonb,p_observation jsonb,p_output_cap integer) returns bigint
language plpgsql immutable set search_path='' as $$
declare
  inputs bigint;
  outputs bigint;
  hits bigint;
  misses bigint;
  provider_model text;
begin
  if p_observation->>'status' is distinct from 'observed' then return null; end if;
  provider_model := lower(p_observation->>'provider_model');
  if p_billing->>'model' is null or public.chat_paid_provider_model_family(provider_model) is distinct from p_billing->>'model'
    or jsonb_typeof(p_billing->'provider_models') is distinct from 'array' then
    return null;
  end if;
  if not exists(select 1 from jsonb_array_elements_text(p_billing->'provider_models') as a(alias) where lower(a.alias)=provider_model) then
    return null;
  end if;
  inputs := (p_observation->>'input_tokens')::bigint;
  outputs := (p_observation->>'output_tokens')::bigint;
  if outputs > p_output_cap or inputs+outputs > 1048576 then return null; end if;
  hits := (p_observation->>'cache_hit_tokens')::bigint;
  misses := (p_observation->>'cache_miss_tokens')::bigint;
  if inputs=0 then hits:=0; misses:=0; end if;
  hits := coalesce(hits,inputs-misses);
  misses := coalesce(misses,inputs-hits);
  if hits is null or misses is null or hits+misses<>inputs then return null; end if;
  return hits*(p_billing->'rates_nano'->>'cache_hit')::bigint + misses*(p_billing->'rates_nano'->>'cache_miss')::bigint
    + outputs*(p_billing->'rates_nano'->>'output')::bigint;
end $$;

create function public.require_paid_chat_model_authorization() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.chat_completion_jobs where id=new.job_id and paid_billing is not null)
    and not exists(select 1 from public.chat_paid_call_limits where job_id=new.job_id and call_id=new.call_id) then
    raise exception 'paid model has no budget authorization' using errcode='55000',detail='chat_paid_budget_exhausted';
  end if;
  return new;
end $$;
create trigger chat_paid_model_authorization before insert on public.chat_model_calls
for each row execute function public.require_paid_chat_model_authorization();

create function public.authorize_chat_paid_model(p_job_id uuid,p_lease uuid,p_call_id text,p_model text,p_max_output_tokens integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  job public.chat_completion_jobs;
  hold public.credit_holds;
  used bigint;
  risk bigint;
  rates jsonb;
begin
  select * into job from public.chat_completion_jobs where id=p_job_id for update;
  if not found or job.paid_billing is null or job.lease_id is distinct from p_lease or p_lease is null
    or job.status <> 'running' or least(job.content_expires_at,job.lease_expires_at)<=clock_timestamp() then
    raise exception 'invalid paid chat lease' using errcode='55000';
  end if;
  if p_call_id is null or p_call_id !~ '^[0-9a-f]{64}$' or job.paid_billing->>'model' is distinct from p_model or p_max_output_tokens is null
    or p_max_output_tokens not between 1 and (job.paid_billing->>'max_output_tokens')::integer then
    raise exception 'invalid paid model authorization' using errcode='22023';
  end if;
  if exists(select 1 from public.chat_model_calls where job_id=p_job_id and call_id=p_call_id) then return false; end if;
  select * into hold from public.credit_holds where id=job.hold_id for update;
  if hold.status is distinct from 'pending_settlement' or job.estimated_credits <> (select coalesce(sum(amount),0)
    from public.credit_hold_allocations where hold_id=job.hold_id) then
    raise exception 'paid model hold not fully allocated' using errcode='55000',detail='chat_paid_budget_exhausted';
  end if;
  rates := job.paid_billing->'rates_nano';
  risk := 1048576 * (rates->>'cache_miss')::bigint + p_max_output_tokens*((rates->>'output')::bigint-(rates->>'cache_miss')::bigint);
  select coalesce(sum(coalesce(public.chat_paid_rated_nano(job.paid_billing,c.observation,b.max_output_tokens),b.risk_nano)),0)
    into used from public.chat_paid_call_limits b join public.chat_model_calls c using(job_id,call_id) where b.job_id=p_job_id;
  if used + risk > job.estimated_credits::bigint*1000000000 then
    raise exception 'next paid chat call exceeds approved budget' using errcode='P0001',detail='chat_paid_budget_exhausted';
  end if;
  insert into public.chat_paid_call_limits(job_id,call_id,max_output_tokens,risk_nano) values(p_job_id,p_call_id,p_max_output_tokens,risk);
  if not public.record_chat_model_call(p_job_id,p_lease,p_call_id,p_model,null) then
    raise exception 'inconsistent paid chat call' using errcode='55000';
  end if;
  return true;
end $$;

-- Keep old RPC defaults and replay semantics, but prevent old Edge from
-- uploading/reenqueuing an existing paid job as a free request.
alter function public.begin_chat_session_turn(uuid,text,text,text,bigint,integer,boolean,text) rename to begin_chat_free_session_turn;
revoke all on function public.begin_chat_free_session_turn(uuid,text,text,text,bigint,integer,boolean,text) from public,anon,authenticated,service_role;
create function public.begin_chat_session_turn(p_user_id uuid,p_key text,p_hash text,p_object_key text,p_daily_cost_limit bigint,p_per_minute integer,p_dsh_tools boolean,p_conversation text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
  job := public.begin_chat_free_session_turn(p_user_id,p_key,p_hash,p_object_key,p_daily_cost_limit,p_per_minute,p_dsh_tools,p_conversation);
  if job.paid_billing is not null then
    raise exception 'idempotency key reused for different content' using errcode='22023',detail='chat_paid_price_mismatch';
  end if;
  return job;
end $$;

create function public.begin_chat_paid_turn(p_user_id uuid,p_key text,p_hash text,p_object_key text,p_daily_cost_limit bigint,p_per_minute integer,
  p_dsh_tools boolean,p_conversation text,p_model text,p_pricing_version integer,p_max_credits integer,p_max_output_tokens integer)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare
  account_session text;
  job public.chat_completion_jobs;
  previous uuid;
  quote jsonb;
  held record;
  price_service text;
  provider_models jsonb;
  day_key date := (now() at time zone 'Asia/Shanghai')::date;
  minute_key timestamptz := date_trunc('minute',now());
  provider_micros bigint;
begin
  if p_user_id is null or p_key is null or char_length(p_key) not between 1 and 200 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
    or p_object_key is null or p_dsh_tools is null or p_conversation is null or p_conversation !~ '^[A-Za-z0-9_-]{1,128}$'
    or p_model is null or p_model not in ('deepseek-flash','deepseek-v4-pro') or p_daily_cost_limit is null or p_daily_cost_limit <= 0
    or p_per_minute is null or p_per_minute <= 0 then
    raise exception 'invalid paid chat request' using errcode='22023';
  end if;
  account_session := encode(sha256(convert_to('bowerbird:dsh-v2:'||p_user_id::text||':'||p_conversation,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(account_session,1));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
  select * into job from public.chat_completion_jobs where user_id=p_user_id and idempotency_key=p_key;
  if found then
    if job.input_hash<>p_hash or job.dsh_session_key is distinct from account_session
      or job.dsh_tools_enabled is distinct from p_dsh_tools or job.paid_billing->>'model' is distinct from p_model
      or job.pricing_version is distinct from p_pricing_version or job.estimated_credits is distinct from p_max_credits
      or (job.paid_billing->>'max_output_tokens')::integer is distinct from p_max_output_tokens then
      raise exception 'conflicting paid chat quote or original request' using errcode='22023',detail='chat_paid_price_mismatch';
    end if;
    return job;
  end if;
  if exists(select 1 from public.chat_completion_jobs where dsh_session_key=account_session and status in ('uploading','queued','running')) then
    raise exception 'chat session has an active turn' using errcode='55000',detail='chat_session_busy';
  end if;
  if left(p_conversation,2)='t-' and exists(select 1 from public.chat_completion_jobs where dsh_session_key=account_session) then
    raise exception 'idempotency key reused for different content' using errcode='22023';
  end if;
  price_service := case p_model when 'deepseek-flash' then 'chat_paid_flash_v1' else 'chat_paid_pro_v1' end;
  select parameters->'provider_models' into provider_models from public.service_costs where service=price_service for share;
  quote := public.quote_chat_paid_turn(p_model);
  if quote->>'available'<>'true' then
    raise exception 'paid chat unavailable' using errcode='55000',detail='chat_paid_unavailable';
  end if;
  if (quote->>'pricing_version')::integer is distinct from p_pricing_version or (quote->>'max_credits')::integer is distinct from p_max_credits
    or (quote->>'max_output_tokens')::integer is distinct from p_max_output_tokens then
    raise exception 'paid chat price changed' using errcode='22023',detail='chat_paid_price_mismatch';
  end if;
  select * into held from public.credit_hold(p_user_id,'chat:'||p_key,price_service,p_max_credits);
  if held.status <> 'held' or held.pricing_version <> p_pricing_version then
    raise exception 'invalid paid chat hold' using errcode='55000';
  end if;
  -- The fixed customer rate is 32 Bcoin per CNY of published peak cost.
  -- Admission books the whole approved ceiling to the isolated chat bucket.
  provider_micros := (p_max_credits::bigint * 1000000 + 31)/32;
  insert into public.usage_minute as u(user_id,minute_start,request_count) values(p_user_id,minute_key,1)
    on conflict(user_id,minute_start) do update set request_count=u.request_count+1 where u.request_count<p_per_minute;
  if not found then raise exception 'managed minute cap' using errcode='P0001',detail='rate_limit_per_minute'; end if;
  if provider_micros > p_daily_cost_limit then raise exception 'paid chat daily cost cap' using errcode='P0001',detail='daily_cost_limit'; end if;
  insert into public.system_chat_usage_daily as u(business_date,request_count,cost_micros)
    values(day_key,1,provider_micros) on conflict(business_date) do update set request_count=u.request_count+1,
      cost_micros=u.cost_micros+provider_micros,updated_at=now() where u.cost_micros<=p_daily_cost_limit-provider_micros;
  if not found then raise exception 'paid chat daily cost cap' using errcode='P0001',detail='daily_cost_limit'; end if;
  insert into public.usage_daily as u(user_id,business_date,request_count,cost_micros) values(p_user_id,day_key,1,provider_micros)
    on conflict(user_id,business_date) do update set request_count=u.request_count+1,cost_micros=u.cost_micros+provider_micros;
  update public.credit_holds set reserved_cost_micros=provider_micros,billing_snapshot=quote,expires_at=now()+interval '24 hours' where id=held.hold_id;
  -- The chat job owns release until its content deadline; the generic held-only sweeper must not race it.
  perform public.mark_hold_pending_settlement(held.hold_id,'paid chat job awaiting upload');
  select id into previous from public.chat_completion_jobs where dsh_session_key=account_session and status='succeeded'
    order by finished_at desc,id desc limit 1;
  insert into public.chat_completion_jobs(user_id,idempotency_key,input_hash,request_object_key,hold_id,estimated_credits,pricing_version,
    dsh_tools_enabled,dsh_session_key,dsh_previous_job_id,paid_billing)
  values(p_user_id,p_key,p_hash,p_object_key,held.hold_id,p_max_credits,p_pricing_version,p_dsh_tools,account_session,previous,
    quote || jsonb_build_object('provider_models',provider_models))
  returning * into job;
  return job;
end $$;

create function public.settle_chat_paid_turn(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare
  job public.chat_completion_jobs;
  hold public.credit_holds;
  can_bill boolean;
  fee bigint := 0;
  missing integer;
  calls integer;
  prior_carry bigint;
  next_carry bigint;
  debit integer;
begin
  select * into job from public.chat_completion_jobs where id=p_id for update;
  if not found or job.paid_billing is null or job.status in ('uploading','queued','running')
    or exists(select 1 from public.chat_paid_receipts where job_id=p_id) then return; end if;
  can_bill := job.status='succeeded' or (job.status='outcome_unknown' and job.error_code is not distinct from 'chat_cancelled');
  if can_bill then
    select count(*),count(*) filter(where rated is null),coalesce(sum(rated),0) into calls,missing,fee
    from (select public.chat_paid_rated_nano(job.paid_billing,c.observation,b.max_output_tokens) as rated
      from public.chat_model_calls c join public.chat_paid_call_limits b using(job_id,call_id) where c.job_id=p_id) priced;
    if (missing>0 or (calls=0 and job.status='succeeded')) and job.content_expires_at>clock_timestamp() then return; end if;
  elsif job.status='outcome_unknown' and job.content_expires_at>clock_timestamp() then return;
  end if;

  perform 1 from public.user_credits where user_id=job.user_id for update;
  select * into hold from public.credit_holds where id=job.hold_id for update;
  insert into public.chat_paid_accounts(user_id) values(job.user_id) on conflict(user_id) do nothing;
  select carry_nano into prior_carry from public.chat_paid_accounts where user_id=job.user_id for update;
  debit := (prior_carry+fee)/1000000000;
  next_carry := (prior_carry+fee)%1000000000;
  if fee > job.estimated_credits::bigint*1000000000 or debit>job.estimated_credits
    or debit > (select coalesce(sum(amount),0) from public.credit_hold_allocations where hold_id=job.hold_id) then
    raise exception 'paid chat fee exceeds approved or actual hold' using errcode='55000',detail='chat_paid_budget_exhausted';
  end if;
  if can_bill and (fee>0 or job.status='succeeded') then
    perform public.credit_confirm(job.hold_id,debit);
  elsif hold.status not in ('rolled_back','expired') then
    perform public.credit_rollback(job.hold_id,'paid chat without chargeable usage');
  end if;
  update public.chat_paid_accounts set carry_nano=next_carry where user_id=job.user_id;
  insert into public.chat_paid_receipts(job_id,user_id,fee_nano,debited_credits,carry_nano)
    values(p_id,job.user_id,fee,debit,next_carry);
  update public.chat_completion_jobs set actual_credits=debit where id=p_id;
end $$;

alter function public.finish_chat_completion(uuid,uuid,text,jsonb,text) rename to finish_chat_free_completion;
revoke all on function public.finish_chat_free_completion(uuid,uuid,text,jsonb,text) from public,anon,authenticated,service_role;
create function public.finish_chat_completion(p_id uuid,p_lease uuid,p_status text,p_result jsonb,p_error text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.chat_completion_jobs where id=p_id and paid_billing is not null) then
    raise exception 'paid chat requires paid-capable finish' using errcode='55000';
  end if;
  return public.finish_chat_free_completion(p_id,p_lease,p_status,p_result,p_error);
end $$;

create function public.finish_chat_paid_turn(p_id uuid,p_lease uuid,p_status text,p_result jsonb,p_error text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
  select * into job from public.chat_completion_jobs where id=p_id for update;
  if not found or job.lease_id is distinct from p_lease or p_lease is null then raise exception 'chat lease invalid' using errcode='55000'; end if;
  if job.paid_billing is null then return public.finish_chat_free_completion(p_id,p_lease,p_status,p_result,p_error); end if;
  if job.status not in ('succeeded','failed','outcome_unknown') then
    if job.status<>'running' or job.lease_expires_at<=clock_timestamp() or p_status is null or p_status not in ('succeeded','failed','outcome_unknown') then
      raise exception 'paid chat finish invalid or expired' using errcode='55000';
    end if;
    if p_status='succeeded' and (p_result->'message'->>'role' is distinct from 'assistant'
      or p_result->>'model' is distinct from job.paid_billing->>'model'
      or coalesce((p_result->'usage'->>'input_tokens')::bigint,-1)<0 or coalesce((p_result->'usage'->>'output_tokens')::bigint,-1)<0
      or not exists (select 1 from public.chat_paid_call_limits where job_id=p_id)) then
      raise exception 'invalid paid chat result' using errcode='22023';
    end if;
    update public.chat_completion_jobs set status=p_status,result_json=case when p_status='succeeded' then p_result else null end,
      input_tokens=case when p_status='succeeded' then (p_result->'usage'->>'input_tokens')::bigint end,
      output_tokens=case when p_status='succeeded' then (p_result->'usage'->>'output_tokens')::bigint end,
      provider_model=case when p_status='succeeded' then p_result->>'model' end,
      -- This code on a running job is never enough to bill a claimed user stop.
      -- Only the owner-facing cancel RPC establishes that transition first.
      error_code=case when p_status='succeeded' then null when p_error='chat_cancelled' then 'chat_worker_error'
        else left(coalesce(p_error,'chat_failed'),80) end,finished_at=now()
    where id=p_id;
  end if;
  perform public.settle_chat_paid_turn(p_id);
  select * into job from public.chat_completion_jobs where id=p_id;
  return job;
end $$;

create or replace function public.claim_chat_engine(p_worker text,p_lane text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
 if p_lane is null or p_lane not in ('completion','dsh-v1','dsh-v2','dsh-v2-paid') then raise exception 'invalid lane'; end if;
 if p_worker is null or char_length(p_worker) not between 1 and 120 then raise exception 'invalid worker'; end if;
 update public.chat_completion_jobs set status='outcome_unknown',error_code='chat_outcome_unknown',finished_at=now()
 where status='running' and lease_expires_at<now();
 for job in select * from public.chat_completion_jobs where content_expires_at<now() and status in ('uploading','queued') for update skip locked loop
  if job.paid_billing is null or (select status from public.credit_holds where id=job.hold_id) not in ('rolled_back','expired') then
   perform public.credit_rollback(job.hold_id,'chat input expired before execution');
  end if;
  update public.chat_completion_jobs set status='failed',error_code='chat_expired',actual_credits=0,finished_at=now() where id=job.id;
 end loop;
 select * into job from public.chat_completion_jobs where status='queued' and (paid_billing is null or p_lane='dsh-v2-paid') and (
   (p_lane='completion' and dsh_tools_enabled is null)
   or (p_lane='dsh-v1' and dsh_tools_enabled is not null and dsh_session_key is null)
   or (p_lane in ('dsh-v2','dsh-v2-paid') and dsh_tools_enabled is not null))
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.chat_completion_jobs set status='running',lease_id=extensions.gen_random_uuid(),
  lease_expires_at=case when dsh_tools_enabled is null then now()+interval '180 seconds'
   else least(content_expires_at,now()+interval '180 seconds') end
 where id=job.id returning * into job;
 perform public.mark_hold_pending_settlement(job.hold_id,'DeepSeek chat completion claimed');
 return job;
end $$;

create function public.claim_chat_paid_turn(p_worker text) returns public.chat_completion_jobs
language plpgsql security definer set search_path='' as $$
declare pending uuid;
begin
  if p_worker is null or char_length(p_worker) not between 1 and 120 then raise exception 'invalid worker'; end if;
  select id into pending from public.chat_completion_jobs j where j.paid_billing is not null
    and j.status in ('succeeded','failed','outcome_unknown')
    and (j.content_expires_at<=clock_timestamp() or ((j.status='succeeded' or
      (j.status='outcome_unknown' and j.error_code='chat_cancelled'))
      and exists(select 1 from public.chat_paid_call_limits b where b.job_id=j.id)
      and not exists(select 1 from public.chat_paid_call_limits b join public.chat_model_calls c using(job_id,call_id)
        where b.job_id=j.id and public.chat_paid_rated_nano(j.paid_billing,c.observation,b.max_output_tokens) is null)))
    and (j.paid_reconcile_after is null or j.paid_reconcile_after<=clock_timestamp())
    and not exists(select 1 from public.chat_paid_receipts where job_id=j.id)
    order by j.content_expires_at,j.id for update skip locked limit 1;
  if pending is not null then
    begin
      perform public.settle_chat_paid_turn(pending);
    exception when SQLSTATE '55000' then
      -- An inconsistent hold still requires repair. Let other jobs make progress.
      update public.chat_completion_jobs set paid_reconcile_after=clock_timestamp()+interval '5 minutes' where id=pending;
      raise warning 'paid chat hold needs review';
    end;
  end if;
  return public.claim_chat_engine(p_worker,'dsh-v2-paid');
end $$;

alter function public.enqueue_chat_completion(uuid,text,boolean) rename to enqueue_chat_owned_completion;
revoke all on function public.enqueue_chat_owned_completion(uuid,text,boolean) from public,anon,authenticated,service_role;
create function public.enqueue_chat_completion(p_id uuid,p_hash text,p_success boolean) returns public.chat_completion_jobs
language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
  job := public.enqueue_chat_owned_completion(p_id,p_hash,p_success);
  if job.paid_billing is not null and job.status='failed' then
    perform public.settle_chat_paid_turn(job.id);
    select * into job from public.chat_completion_jobs where id=p_id;
  end if;
  return job;
end $$;

alter function public.cancel_chat_dsh(uuid,uuid,text) rename to cancel_chat_dsh_owned;
revoke all on function public.cancel_chat_dsh_owned(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.cancel_chat_dsh(p_user uuid,p_id uuid,p_key text) returns public.chat_completion_jobs
language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
  job := public.cancel_chat_dsh_owned(p_user,p_id,p_key);
  if job.paid_billing is not null then
    perform public.settle_chat_paid_turn(job.id);
    select * into job from public.chat_completion_jobs where id=job.id;
  end if;
  return job;
end $$;

create function public.get_chat_paid_receipt(p_user_id uuid,p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('status',case when r.refund_reference is not null then 'refunded' when r.job_id is null then 'pending' else 'settled' end,
    'pricing_version',j.pricing_version,'model',j.paid_billing->>'model','max_credits',j.estimated_credits) ||
    case when r.job_id is not null then jsonb_build_object('fee_nano',r.fee_nano::text,'debited_credits',r.debited_credits,
      'carry_nano',coalesce(r.refund_carry_nano,r.carry_nano)::text,'refund_credits',r.refunded_credits) else '{}'::jsonb end
  from public.chat_completion_jobs j left join public.chat_paid_receipts r on r.job_id=j.id
  where j.id=p_id and j.user_id=p_user_id and j.paid_billing is not null
$$;

-- Operator reversal, not a repeat of confirm. Undo the latest outstanding whole
-- DSH debits first and restore their exact lots without changing original expiry.
create function public.refund_chat_paid_turn(p_id uuid,p_reference text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  receipt public.chat_paid_receipts;
  allocation record;
  delta bigint;
  next_carry bigint;
  refund integer;
  remaining integer;
  part integer;
begin
  if p_reference is null or p_reference !~ '^[A-Za-z0-9._:/-]{1,120}$' then
    raise exception 'paid chat refund requires an audit reference' using errcode='22023';
  end if;
  select user_id into receipt.user_id from public.chat_paid_receipts where job_id=p_id;
  if not found then raise exception 'unknown paid chat receipt' using errcode='22023'; end if;
  perform 1 from public.user_credits where user_id=receipt.user_id for update;
  select * into receipt from public.chat_paid_receipts where job_id=p_id for update;
  if receipt.refund_reference is not null then
    if receipt.refund_reference<>p_reference then raise exception 'paid chat refund already recorded' using errcode='55000'; end if;
    return public.get_chat_paid_receipt(receipt.user_id,p_id);
  end if;
  select carry_nano-receipt.fee_nano into delta from public.chat_paid_accounts where user_id=receipt.user_id for update;
  -- SQL integer division truncates toward zero, not toward negative infinity.
  refund := case when delta<0 then (-delta+999999999)/1000000000 else 0 end;
  next_carry := delta+refund::bigint*1000000000;
  remaining := refund;
  for allocation in
    select a.hold_id,a.lot_id,a.amount,h.service from public.chat_paid_receipts r
    join public.chat_completion_jobs j on j.id=r.job_id
    join public.credit_holds h on h.id=j.hold_id and h.status='confirmed'
    join public.credit_hold_allocations a on a.hold_id=h.id
    join public.credit_lots l on l.id=a.lot_id
    where r.user_id=receipt.user_id and r.debited_credits>0
    order by r.seq desc,case l.bucket when 'topup' then 0 when 'sub' then 1 else 2 end,
      l.expires_at desc,l.created_at desc,l.id desc for update of a,l
  loop
    exit when remaining=0;
    part := least(remaining,allocation.amount);
    update public.credit_lots set remaining_amount=remaining_amount+part where id=allocation.lot_id;
    if part=allocation.amount then
      delete from public.credit_hold_allocations where hold_id=allocation.hold_id and lot_id=allocation.lot_id;
    else
      update public.credit_hold_allocations set amount=amount-part where hold_id=allocation.hold_id and lot_id=allocation.lot_id;
    end if;
    insert into public.credit_transactions(user_id,hold_id,lot_id,kind,amount,service,meta)
      values(receipt.user_id,allocation.hold_id,allocation.lot_id,'refund',part,allocation.service,
        jsonb_build_object('refunded_chat_job_id',p_id,'reference',p_reference));
    remaining := remaining-part;
  end loop;
  if remaining<>0 then raise exception 'paid chat refund allocations missing' using errcode='55000'; end if;
  update public.chat_paid_accounts set carry_nano=next_carry where user_id=receipt.user_id;
  update public.chat_paid_receipts set refunded_credits=refund,refund_carry_nano=next_carry,refund_reference=p_reference where job_id=p_id;
  perform public.refresh_user_credit_snapshot(receipt.user_id);
  return public.get_chat_paid_receipt(receipt.user_id,p_id);
end $$;

revoke all on function public.chat_paid_provider_model_family(text),public.chat_paid_rated_nano(jsonb,jsonb,integer),public.require_paid_chat_model_authorization(),
  public.settle_chat_paid_turn(uuid) from public,anon,authenticated,service_role;
revoke all on function public.quote_chat_paid_turn(text),
  public.begin_chat_session_turn(uuid,text,text,text,bigint,integer,boolean,text),
  public.begin_chat_paid_turn(uuid,text,text,text,bigint,integer,boolean,text,text,integer,integer,integer),
  public.authorize_chat_paid_model(uuid,uuid,text,text,integer),public.get_chat_paid_receipt(uuid,uuid),public.refund_chat_paid_turn(uuid,text),
  public.finish_chat_completion(uuid,uuid,text,jsonb,text),public.finish_chat_paid_turn(uuid,uuid,text,jsonb,text),
  public.claim_chat_paid_turn(text),public.cancel_chat_dsh(uuid,uuid,text),public.enqueue_chat_completion(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.quote_chat_paid_turn(text),public.begin_chat_session_turn(uuid,text,text,text,bigint,integer,boolean,text),
  public.begin_chat_paid_turn(uuid,text,text,text,bigint,integer,boolean,text,text,integer,integer,integer),
  public.authorize_chat_paid_model(uuid,uuid,text,text,integer),public.get_chat_paid_receipt(uuid,uuid),public.refund_chat_paid_turn(uuid,text),
  public.finish_chat_completion(uuid,uuid,text,jsonb,text),public.finish_chat_paid_turn(uuid,uuid,text,jsonb,text),
  public.claim_chat_paid_turn(text),public.cancel_chat_dsh(uuid,uuid,text),public.enqueue_chat_completion(uuid,text,boolean) to service_role;

-- Keep the 0095 receipt contract and grants. A paid reply can be delivered
-- while its original authorized call is still awaiting its first observation.
create or replace function public.record_chat_model_call(p_job_id uuid, p_lease uuid, p_call_id text, p_model text, p_observation jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  job public.chat_completion_jobs;
  current_call public.chat_model_calls;
  field text;
  token_fields text[] := array['input_tokens','output_tokens','cache_hit_tokens','cache_miss_tokens'];
begin
  if p_call_id is null or p_call_id !~ '^[0-9a-f]{64}$'
    or p_model is null or p_model not in ('deepseek-flash','deepseek-v4-pro') then
    raise exception 'invalid chat model call' using errcode='22023';
  end if;

  select * into job from public.chat_completion_jobs where id=p_job_id for update;
  if not found or job.dsh_session_key is null or p_lease is null or job.lease_id is distinct from p_lease then
    raise exception 'invalid chat model lease' using errcode='55000';
  end if;
  select * into current_call from public.chat_model_calls where job_id=p_job_id and call_id=p_call_id;
  if found and (current_call.lease_id <> p_lease or current_call.requested_model <> p_model) then
    raise exception 'conflicting chat model identity' using errcode='22023';
  end if;

  if p_observation is null then
    if current_call.job_id is not null then return false; end if;
    if job.status <> 'running' or least(job.content_expires_at, job.lease_expires_at) <= clock_timestamp() then
      raise exception 'inactive chat model lease' using errcode='55000';
    end if;
    if (select count(*) from public.chat_model_calls where job_id=p_job_id) >= 12 then
      raise exception 'chat model call count exceeded' using errcode='55000';
    end if;
    insert into public.chat_model_calls (job_id, lease_id, call_id, requested_model)
      values (p_job_id, p_lease, p_call_id, p_model);
    return true;
  end if;

  if current_call.job_id is null then raise exception 'chat model call was not submitted' using errcode='55000'; end if;
  if current_call.observation is not null then
    if current_call.observation = p_observation then return true; end if;
    raise exception 'conflicting chat model observation' using errcode='22023';
  end if;
  -- Cancellation and lease expiry already stop new calls. The original lease
  -- can still report an existing call within the job lifetime.
  if (job.status not in ('running','outcome_unknown') and not (job.status='succeeded' and job.paid_billing is not null
    and not exists(select 1 from public.chat_paid_receipts where job_id=p_job_id)
    and exists(select 1 from public.chat_paid_call_limits where job_id=p_job_id and call_id=p_call_id)))
    or job.content_expires_at <= clock_timestamp() then
    raise exception 'closed chat model observation' using errcode='55000';
  end if;
  if jsonb_typeof(p_observation) is distinct from 'object' then
    raise exception 'invalid chat model observation' using errcode='22023';
  end if;
  case p_observation->>'status'
    when 'observed' then
      if p_observation - (token_fields || array['status','provider_model','provider_request_id']) <> '{}'::jsonb
        or not (p_observation ?& array['input_tokens','output_tokens']) then
        raise exception 'invalid chat model observation' using errcode='22023';
      end if;
      foreach field in array token_fields loop
        if p_observation ? field and (jsonb_typeof(p_observation->field) <> 'number'
          or not (p_observation->>field ~ '^[0-9]{1,8}$')
          or (p_observation->>field)::numeric > 10000000) then
          raise exception 'invalid chat token count' using errcode='22023';
        end if;
      end loop;
      if (p_observation->>'cache_hit_tokens')::numeric > (p_observation->>'input_tokens')::numeric
        or (p_observation->>'cache_miss_tokens')::numeric > (p_observation->>'input_tokens')::numeric
        or (p_observation->>'cache_hit_tokens')::numeric + (p_observation->>'cache_miss_tokens')::numeric <> (p_observation->>'input_tokens')::numeric then
        raise exception 'invalid chat cache token count' using errcode='22023';
      end if;
      if (p_observation ? 'provider_model' and (jsonb_typeof(p_observation->'provider_model') <> 'string'
          or p_observation->>'provider_model' !~ '^[A-Za-z0-9._:/-]{1,120}$'))
        or (p_observation ? 'provider_request_id' and (jsonb_typeof(p_observation->'provider_request_id') <> 'string'
          or p_observation->>'provider_request_id' !~ '^[A-Za-z0-9._:/-]{1,200}$')) then
        raise exception 'invalid chat provider identity' using errcode='22023';
      end if;
    when 'http_error' then
      if p_observation - array['status','http_status'] <> '{}'::jsonb
        or jsonb_typeof(p_observation->'http_status') is distinct from 'number'
        or not (p_observation->>'http_status' ~ '^[45][0-9]{2}$') then
        raise exception 'invalid chat model HTTP status' using errcode='22023';
      end if;
    when 'unknown' then
      if p_observation - 'status' <> '{}'::jsonb then
        raise exception 'invalid unknown chat model observation' using errcode='22023';
      end if;
    else raise exception 'invalid chat model observation' using errcode='22023';
  end case;

  update public.chat_model_calls set observation=p_observation, observed_at=clock_timestamp()
    where job_id=p_job_id and call_id=p_call_id;
  return true;
end;
$$;
