-- Desktop owns the conversation/tool loop. This queue executes one model completion.
insert into public.service_costs(service,unit_cost,active,pricing_version,parameters)
values('chat_deepseek',0,true,20261031,'{"currency":"Bcoin","test_price":true,"provider_cost_reserve_micros":2000000,"max_output_tokens":8192}'::jsonb);

alter table public.credit_holds drop constraint credit_holds_estimated_amount_check;
alter table public.credit_holds add constraint credit_holds_estimated_amount_check
  check(estimated_amount>0 or (service='chat_deepseek' and estimated_amount=0));

create table public.chat_completion_jobs (
 id uuid primary key default extensions.gen_random_uuid(),
 user_id uuid not null references public.billing_accounts(id),
 idempotency_key text not null check(char_length(idempotency_key) between 1 and 200),
 input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
 request_object_key text not null check(char_length(request_object_key) between 1 and 512),
 result_json jsonb,
 status text not null default 'uploading' check(status in ('uploading','queued','running','succeeded','failed','outcome_unknown')),
 hold_id uuid not null unique references public.credit_holds(id),
 estimated_credits integer not null check(estimated_credits>=0),
 actual_credits integer check(actual_credits>=0),
 input_tokens bigint check(input_tokens>=0),
 output_tokens bigint check(output_tokens>=0),
 provider_model text,
 pricing_version integer not null,
 lease_id uuid,
 lease_expires_at timestamptz,
 error_code text,
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 content_expires_at timestamptz not null default now()+interval '24 hours',
 content_deleted_at timestamptz,
 unique(user_id,idempotency_key),
 check(result_json is null or octet_length(result_json::text)<=400000)
);
create index chat_completion_jobs_queue on public.chat_completion_jobs(created_at) where status='queued';
alter table public.chat_completion_jobs enable row level security;
alter table public.chat_completion_jobs force row level security;
revoke all on public.chat_completion_jobs from public,anon,authenticated;
grant all on public.chat_completion_jobs to service_role;

create function public.begin_chat_completion(p_user_id uuid,p_key text,p_hash text,p_object_key text,p_daily_cost_limit bigint,p_per_minute integer)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs; held record; cost public.service_costs;
begin
 if char_length(p_key) not between 1 and 200 or p_hash !~ '^[0-9a-f]{64}$' or p_object_key is null then
  raise exception 'invalid chat request' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
 select * into job from public.chat_completion_jobs where user_id=p_user_id and idempotency_key=p_key;
 if found then
  if job.input_hash<>p_hash then raise exception 'idempotency key reused for different content' using errcode='22023'; end if;
  return job;
 end if;
 select * into cost from public.service_costs where service='chat_deepseek' and active for share;
 -- Enabling a paid catalog row cannot silently charge a test client without a budget agreement.
 if not found or cost.unit_cost<>0 then raise exception 'chat test price unavailable' using errcode='22023'; end if;
 select * into held from public.credit_hold(p_user_id,'chat:'||p_key,'chat_deepseek',0);
 perform public.reserve_managed_usage(p_user_id,held.hold_id,
  (cost.parameters->>'provider_cost_reserve_micros')::bigint,p_daily_cost_limit,p_per_minute);
 insert into public.chat_completion_jobs(user_id,idempotency_key,input_hash,request_object_key,hold_id,estimated_credits,pricing_version)
 values(p_user_id,p_key,p_hash,p_object_key,held.hold_id,held.estimated_amount,held.pricing_version) returning * into job;
 return job;
end $$;

create function public.enqueue_chat_completion(p_id uuid,p_hash text,p_success boolean)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
 select * into job from public.chat_completion_jobs where id=p_id for update;
 if not found or job.input_hash<>p_hash then raise exception 'chat upload mismatch'; end if;
 if job.status<>'uploading' then return job; end if;
 if not p_success then perform public.credit_rollback(job.hold_id,'chat input upload failed'); end if;
 update public.chat_completion_jobs set status=case when p_success then 'queued' else 'failed' end,
  error_code=case when p_success then null else 'chat_upload_failed' end,
  actual_credits=case when p_success then null else 0 end,finished_at=case when p_success then null else now() end
 where id=p_id returning * into job;
 return job;
end $$;

create function public.claim_chat_completion(p_worker text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
 if p_worker is null or char_length(p_worker) not between 1 and 120 then raise exception 'invalid worker'; end if;
 -- Once a worker has claimed, a crash may have happened after the upstream accepted.
 -- Never requeue or refund an ambiguous completion.
 update public.chat_completion_jobs set status='outcome_unknown',error_code='chat_outcome_unknown',finished_at=now()
 where status='running' and lease_expires_at<now();
 for job in select * from public.chat_completion_jobs where content_expires_at<now() and status in ('uploading','queued') for update skip locked loop
  perform public.credit_rollback(job.hold_id,'chat input expired before execution');
  update public.chat_completion_jobs set status='failed',error_code='chat_expired',actual_credits=0,finished_at=now() where id=job.id;
 end loop;
 select * into job from public.chat_completion_jobs where status='queued' order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.chat_completion_jobs set status='running',lease_id=extensions.gen_random_uuid(),lease_expires_at=now()+interval '180 seconds'
 where id=job.id returning * into job;
 perform public.mark_hold_pending_settlement(job.hold_id,'DeepSeek chat completion claimed');
 return job;
end $$;

create function public.finish_chat_completion(p_id uuid,p_lease uuid,p_status text,p_result jsonb,p_error text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
 select * into job from public.chat_completion_jobs where id=p_id for update;
 if not found or job.lease_id is distinct from p_lease then raise exception 'chat lease invalid'; end if;
 if job.status in ('succeeded','failed') then return job; end if;
 if job.status<>'running' or job.lease_expires_at<now() then raise exception 'chat lease expired'; end if;
 if p_status='succeeded' then
  if p_result is null or p_result->'message'->>'role'<>'assistant'
   or coalesce((p_result->'usage'->>'input_tokens')::bigint,-1)<0
   or coalesce((p_result->'usage'->>'output_tokens')::bigint,-1)<0 then raise exception 'invalid chat result'; end if;
  perform public.credit_confirm(job.hold_id,job.estimated_credits);
 elsif p_status='failed' then
  perform public.credit_rollback(job.hold_id,'chat upstream rejected');
 elsif p_status<>'outcome_unknown' then raise exception 'invalid chat status'; end if;
 update public.chat_completion_jobs set status=p_status,result_json=case when p_status='succeeded' then p_result else null end,
  actual_credits=case when p_status='succeeded' then estimated_credits when p_status='failed' then 0 else null end,
  input_tokens=case when p_status='succeeded' then (p_result->'usage'->>'input_tokens')::bigint else null end,
  output_tokens=case when p_status='succeeded' then (p_result->'usage'->>'output_tokens')::bigint else null end,
  provider_model=case when p_status='succeeded' then p_result->>'model' else null end,
  error_code=case when p_status='succeeded' then null else left(coalesce(p_error,'chat_failed'),80) end,finished_at=now()
 where id=p_id returning * into job;
 return job;
end $$;

revoke all on function public.begin_chat_completion(uuid,text,text,text,bigint,integer) from public,anon,authenticated;
revoke all on function public.enqueue_chat_completion(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.claim_chat_completion(text) from public,anon,authenticated;
revoke all on function public.finish_chat_completion(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.begin_chat_completion(uuid,text,text,text,bigint,integer) to service_role;
grant execute on function public.enqueue_chat_completion(uuid,text,boolean) to service_role;
grant execute on function public.claim_chat_completion(text) to service_role;
grant execute on function public.finish_chat_completion(uuid,uuid,text,jsonb,text) to service_role;
