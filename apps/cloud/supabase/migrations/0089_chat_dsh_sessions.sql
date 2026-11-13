-- Stable, owner-scoped DSH session identity; its committed head is the last
-- successful job. The Worker publishes immutable per-job snapshots before finish.
alter table public.chat_completion_jobs
 add column dsh_session_key text check(dsh_session_key is null or (dsh_tools_enabled is not null and dsh_session_key ~ '^[0-9a-f]{64}$')),
 add column dsh_previous_job_id uuid references public.chat_completion_jobs(id);
create unique index chat_dsh_one_active_session on public.chat_completion_jobs(dsh_session_key)
 where dsh_session_key is not null and status in ('uploading','queued','running');
create index chat_dsh_committed_session on public.chat_completion_jobs(dsh_session_key,finished_at desc,id desc)
 where dsh_session_key is not null and status='succeeded';

create function public.begin_chat_session_turn(p_user_id uuid,p_key text,p_hash text,p_object_key text,p_daily_cost_limit bigint,p_per_minute integer,p_dsh_tools boolean,p_conversation text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare session_key text; job public.chat_completion_jobs; previous uuid;
begin
 if p_conversation is null or p_conversation !~ '^[A-Za-z0-9_-]{1,128}$' or p_dsh_tools is null then raise exception 'invalid chat session'; end if;
 session_key := encode(sha256(convert_to('bowerbird:dsh-v2:'||p_user_id::text||':'||p_conversation,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(session_key,1));
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
 select * into job from public.chat_completion_jobs where user_id=p_user_id and idempotency_key=p_key;
 if found then
  if job.input_hash<>p_hash or job.dsh_session_key is distinct from session_key or job.dsh_tools_enabled is distinct from p_dsh_tools then
   raise exception 'idempotency key reused for different content' using errcode='22023';
  end if;
  return job;
 end if;
 if exists(select 1 from public.chat_completion_jobs where dsh_session_key=session_key and status in ('uploading','queued','running')) then
  raise exception 'chat session has an active turn' using errcode='55000',detail='chat_session_busy';
 end if;
 -- t- identifies a desktop automation item. Its original request can be recovered,
 -- but no subsequent request can reuse that one-turn session or expect a checkpoint.
 if left(p_conversation,2)='t-' and exists(select 1 from public.chat_completion_jobs where dsh_session_key=session_key) then
  raise exception 'idempotency key reused for different content' using errcode='22023';
 end if;
 select id into previous from public.chat_completion_jobs where dsh_session_key=session_key and status='succeeded'
 order by finished_at desc,id desc limit 1;
 select * into job from public.begin_chat_turn(p_user_id,p_key,p_hash,p_object_key,p_daily_cost_limit,p_per_minute,p_dsh_tools);
 update public.chat_completion_jobs set dsh_session_key=session_key,dsh_previous_job_id=previous where id=job.id returning * into job;
 return job;
end $$;

create function public.claim_chat_engine(p_worker text,p_lane text)
returns public.chat_completion_jobs language plpgsql security definer set search_path='' as $$
declare job public.chat_completion_jobs;
begin
 if p_lane is null or p_lane not in ('completion','dsh-v1','dsh-v2') then raise exception 'invalid lane'; end if;
 if p_worker is null or char_length(p_worker) not between 1 and 120 then raise exception 'invalid worker'; end if;
 -- Once a worker has claimed, a crash may have happened after the upstream accepted.
 -- Never requeue or refund an ambiguous completion.
 update public.chat_completion_jobs set status='outcome_unknown',error_code='chat_outcome_unknown',finished_at=now()
 where status='running' and lease_expires_at<now();
 for job in select * from public.chat_completion_jobs where content_expires_at<now() and status in ('uploading','queued') for update skip locked loop
  perform public.credit_rollback(job.hold_id,'chat input expired before execution');
  update public.chat_completion_jobs set status='failed',error_code='chat_expired',actual_credits=0,finished_at=now() where id=job.id;
 end loop;
 select * into job from public.chat_completion_jobs where status='queued' and (
   (p_lane='completion' and dsh_tools_enabled is null)
   or (p_lane='dsh-v1' and dsh_tools_enabled is not null and dsh_session_key is null)
   or (p_lane='dsh-v2' and dsh_tools_enabled is not null))
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.chat_completion_jobs set status='running',lease_id=extensions.gen_random_uuid(),
  lease_expires_at=case when dsh_tools_enabled is null then now()+interval '180 seconds'
   else least(content_expires_at,now()+interval '180 seconds') end
 where id=job.id returning * into job;
 perform public.mark_hold_pending_settlement(job.hold_id,'DeepSeek chat completion claimed');
 return job;
end $$;

create or replace function public.claim_chat_turn(p_worker text,p_dsh_supported boolean)
returns public.chat_completion_jobs language sql security definer set search_path='' as $$
 select * from public.claim_chat_engine(p_worker,case when p_dsh_supported then 'dsh-v1' else 'completion' end)
$$;

create function public.claim_chat_session_turn(p_worker text)
returns public.chat_completion_jobs language sql security definer set search_path='' as $$
 select * from public.claim_chat_engine(p_worker,'dsh-v2')
$$;

revoke all on function public.begin_chat_session_turn(uuid,text,text,text,bigint,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.begin_chat_session_turn(uuid,text,text,text,bigint,integer,boolean,text) to service_role;
revoke all on function public.claim_chat_engine(text,text) from public,anon,authenticated;
grant execute on function public.claim_chat_engine(text,text) to service_role;
revoke all on function public.claim_chat_session_turn(text) from public,anon,authenticated;
grant execute on function public.claim_chat_session_turn(text) to service_role;
