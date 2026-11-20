-- Per-call observations for DSH v2. Independent of 0094 and the Bcoin ledger.
create table public.chat_model_calls (
  job_id uuid not null references public.chat_completion_jobs(id) on delete cascade,
  call_id text not null check (call_id ~ '^[0-9a-f]{64}$'),
  lease_id uuid not null,
  requested_model text not null check (requested_model in ('deepseek-flash', 'deepseek-v4-pro')),
  submitted_at timestamptz not null default clock_timestamp(),
  business_date date generated always as ((submitted_at at time zone 'Asia/Shanghai')::date) stored,
  observed_at timestamptz,
  observation jsonb,
  primary key (job_id, call_id),
  check ((observation is null) = (observed_at is null))
);
create index chat_model_calls_business_date on public.chat_model_calls (business_date);
alter table public.chat_model_calls enable row level security;
alter table public.chat_model_calls force row level security;
revoke all on public.chat_model_calls from public, anon, authenticated, service_role;
grant select on public.chat_model_calls to service_role;

create function public.record_chat_model_call(p_job_id uuid, p_lease uuid, p_call_id text, p_model text, p_observation jsonb)
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
  if job.status not in ('running','outcome_unknown') or job.content_expires_at <= clock_timestamp() then
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

revoke all on function public.record_chat_model_call(uuid,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_chat_model_call(uuid,uuid,text,text,jsonb) to service_role;
