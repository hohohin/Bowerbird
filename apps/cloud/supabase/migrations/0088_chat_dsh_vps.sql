-- NULL marks a legacy single completion. Boolean values mark a VPS DSH turn
-- with/without desktop tools; this stays immutable across retries and claims.
alter table public.chat_completion_jobs
 add column dsh_tools_enabled boolean,
 add column pending_tool jsonb,
 add column dsh_receipts jsonb not null default '{}';

create function public.begin_chat_turn(p_user_id uuid,p_key text,p_hash text,p_object_key text,p_daily_cost_limit bigint,p_per_minute integer,p_dsh_tools boolean)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs; held record; cost public.service_costs;
begin
 if char_length(p_key) not between 1 and 200 or p_hash !~ '^[0-9a-f]{64}$' or p_object_key is null then
  raise exception 'invalid chat request' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
 select * into job from public.chat_completion_jobs where user_id=p_user_id and idempotency_key=p_key;
 if found then
  if job.input_hash<>p_hash or job.dsh_tools_enabled is distinct from p_dsh_tools then raise exception 'idempotency key reused for different content' using errcode='22023'; end if;
  return job;
 end if;
 select * into cost from public.service_costs where service='chat_deepseek' and active for share;
 -- Enabling a paid catalog row cannot silently charge a test client without a budget agreement.
 if not found or cost.unit_cost<>0 then raise exception 'chat test price unavailable' using errcode='22023'; end if;
 select * into held from public.credit_hold(p_user_id,'chat:'||p_key,'chat_deepseek',0);
 perform public.reserve_managed_usage(p_user_id,held.hold_id,
  (cost.parameters->>'provider_cost_reserve_micros')::bigint * (case when p_dsh_tools is null then 1 else 12 end),p_daily_cost_limit,p_per_minute);
 insert into public.chat_completion_jobs(user_id,idempotency_key,input_hash,request_object_key,hold_id,estimated_credits,pricing_version,dsh_tools_enabled)
 values(p_user_id,p_key,p_hash,p_object_key,held.hold_id,held.estimated_amount,held.pricing_version,p_dsh_tools) returning * into job;
 return job;
end $$;

create or replace function public.begin_chat_completion(p_user_id uuid,p_key text,p_hash text,p_object_key text,p_daily_cost_limit bigint,p_per_minute integer)
returns public.chat_completion_jobs language sql security definer set search_path='' as $$
 select * from public.begin_chat_turn(p_user_id,p_key,p_hash,p_object_key,p_daily_cost_limit,p_per_minute,null)
$$;

create function public.claim_chat_turn(p_worker text,p_dsh_supported boolean)
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
 select * into job from public.chat_completion_jobs where status='queued' and (dsh_tools_enabled is not null)=p_dsh_supported
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.chat_completion_jobs set status='running',lease_id=extensions.gen_random_uuid(),
  lease_expires_at=case when dsh_tools_enabled is null then now()+interval '180 seconds'
   else least(content_expires_at,now()+interval '180 seconds') end
 where id=job.id returning * into job;
 perform public.mark_hold_pending_settlement(job.hold_id,'DeepSeek chat completion claimed');
 return job;
end $$;

create or replace function public.claim_chat_completion(p_worker text)
returns public.chat_completion_jobs language sql security definer set search_path='' as $$
 select * from public.claim_chat_turn(p_worker,false)
$$;

-- Per-job lock serializes worker requests, owner acknowledgments and cancellation
-- with the existing finish, expiry and settlement transactions.
create function public.poll_chat_dsh(p_id uuid,p_lease uuid,p_call text,p_arguments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs; receipt jsonb; digest text;
begin
 select * into job from public.chat_completion_jobs where id=p_id for update;
 if not found or job.dsh_tools_enabled is null or p_lease is null or job.lease_id is distinct from p_lease
  or job.status<>'running' or least(job.content_expires_at,job.lease_expires_at)<=clock_timestamp()
 then return '{"active":false}'; end if;
 if p_call is not null and p_call !~ '^[a-zA-Z0-9_-]{1,120}$' then raise exception 'invalid call id'; end if;
 receipt := job.dsh_receipts->p_call;
 if p_arguments is not null then
  if not job.dsh_tools_enabled or p_call is null or jsonb_typeof(p_arguments)<>'object' then raise exception 'chat tool disabled or invalid'; end if;
  digest := encode(sha256(convert_to(p_arguments::text,'UTF8')),'hex');
  if receipt is not null then
   if receipt->>'hash'<>digest then raise exception 'chat tool call conflict'; end if;
  elsif job.pending_tool is not null then
   if job.pending_tool->>'id'<>p_call or job.pending_tool->'arguments'<>p_arguments then raise exception 'pending chat tool conflict'; end if;
  else
   job.pending_tool := jsonb_build_object('id',p_call,'name','create_canvas_cards','arguments',p_arguments);
  end if;
 end if;
 update public.chat_completion_jobs set lease_expires_at=least(content_expires_at,clock_timestamp()+interval '180 seconds'),
  pending_tool=job.pending_tool where id=p_id;
 return jsonb_strip_nulls(jsonb_build_object('active',true,'result',receipt->'result'));
end $$;

create function public.ack_chat_dsh(p_user uuid,p_id uuid,p_call text,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs; digest text; receipt jsonb;
begin
 select * into job from public.chat_completion_jobs where id=p_id and user_id=p_user for update;
 if not found or job.dsh_tools_enabled is not true or job.status<>'running'
  or least(job.content_expires_at,job.lease_expires_at)<=clock_timestamp() then return false; end if;
 receipt := job.dsh_receipts->p_call;
 if receipt is not null then return receipt->'result'=p_result; end if;
 if job.pending_tool is null or job.pending_tool->>'id' is distinct from p_call then return false; end if;
 digest := encode(sha256(convert_to((job.pending_tool->'arguments')::text,'UTF8')),'hex');
 update public.chat_completion_jobs set pending_tool=null,
  dsh_receipts=dsh_receipts||jsonb_build_object(p_call,jsonb_build_object('hash',digest,'result',p_result)) where id=p_id;
 return true;
end $$;

create function public.cancel_chat_dsh(p_user uuid,p_id uuid,p_key text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
 if (p_id is null)=(p_key is null) then raise exception 'invalid chat identity'; end if;
 select * into job from public.chat_completion_jobs where user_id=p_user and (id=p_id or idempotency_key=p_key) for update;
 if not found or job.dsh_tools_enabled is null then return null; end if;
 if job.status='running' then
  -- A model call may already have been accepted. Keep its pending hold.
  update public.chat_completion_jobs set status='outcome_unknown',error_code='chat_cancelled',finished_at=now() where id=job.id returning * into job;
 elsif job.status in ('uploading','queued') then
  perform public.credit_rollback(job.hold_id,'chat cancelled before execution');
  update public.chat_completion_jobs set status='failed',error_code='chat_cancelled',actual_credits=0,finished_at=now() where id=job.id returning * into job;
 end if;
 return job;
end $$;

create function public.clear_ended_chat_dsh() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='succeeded' and (old.pending_tool is not null or new.result_json->'message' ? 'tool_calls'
     or nullif(btrim(new.result_json->'message'->>'content'),'') is null) then
  raise exception 'DSH turn must finish with plain text and no pending tool';
 end if;
 new.pending_tool := null;
 new.dsh_receipts := '{}';
 return new;
end $$;
create trigger chat_dsh_terminal before update of status on public.chat_completion_jobs for each row
 when (old.dsh_tools_enabled is not null and new.status in ('succeeded','failed','outcome_unknown'))
 execute function public.clear_ended_chat_dsh();

alter table public.chat_completion_jobs add constraint chat_turn_usage_bound
 check (greatest(input_tokens,output_tokens) <= case when dsh_tools_enabled is null then 2000000 else 24000000 end);

revoke all on function public.clear_ended_chat_dsh() from public,anon,authenticated;
revoke all on function public.begin_chat_turn(uuid,text,text,text,bigint,integer,boolean) from public,anon,authenticated;
grant execute on function public.begin_chat_turn(uuid,text,text,text,bigint,integer,boolean) to service_role;
revoke all on function public.claim_chat_turn(text,boolean) from public,anon,authenticated;
grant execute on function public.claim_chat_turn(text,boolean) to service_role;
revoke all on function public.poll_chat_dsh(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.poll_chat_dsh(uuid,uuid,text,jsonb) to service_role;
revoke all on function public.ack_chat_dsh(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.ack_chat_dsh(uuid,uuid,text,jsonb) to service_role;
revoke all on function public.cancel_chat_dsh(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cancel_chat_dsh(uuid,uuid,text) to service_role;
