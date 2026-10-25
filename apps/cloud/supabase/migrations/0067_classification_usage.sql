-- Durable supplier accounting, separate from the 24-hour label response cache.
-- No historical backfill: old requests did not retain trustworthy counters.
create table public.classification_usage (
  classification_id uuid primary key references public.classification_requests(id),
  user_id uuid not null references public.billing_accounts(id),
  provider text not null check(provider in ('ark','mock')),
  requested_model text,
  started_at timestamptz not null default now(),
  received_at timestamptz,
  usage_status text not null default 'pending' check(usage_status in ('pending','recorded','partial','missing','mock')),
  response_id text,
  model text,
  provider_created bigint check(provider_created >= 0),
  prompt_tokens bigint check(prompt_tokens >= 0),
  completion_tokens bigint check(completion_tokens >= 0),
  total_tokens bigint check(total_tokens >= 0),
  cached_tokens bigint check(cached_tokens >= 0),
  reasoning_tokens bigint check(reasoning_tokens >= 0)
);
create index classification_usage_user_time on public.classification_usage(user_id,started_at);
create index classification_usage_pending on public.classification_usage(started_at) where usage_status='pending';
alter table public.classification_usage enable row level security;
alter table public.classification_usage force row level security;
revoke all on public.classification_usage from public,anon,authenticated;
grant select on public.classification_usage to service_role;

create function public.start_classification_usage(p_user_id uuid,p_id uuid,p_provider text,p_requested_model text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  perform 1 from public.classification_requests where id=p_id and user_id=p_user_id
    and status='discovering' and discovery_hash is not null for update;
  if not found then raise exception 'discovery missing' using detail='classification_conflict'; end if;
  insert into public.classification_usage(classification_id,user_id,provider,requested_model)
    values(p_id,p_user_id,p_provider,p_requested_model) on conflict(classification_id) do nothing;
  get diagnostics n=row_count;
  return n=1;
end $$;

create function public.record_classification_usage(p_user_id uuid,p_id uuid,p_usage jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare r public.classification_usage; v public.classification_usage; state text;
begin
  select * into r from public.classification_usage where classification_id=p_id and user_id=p_user_id for update;
  if not found then raise exception 'usage missing' using detail='classification_conflict'; end if;
  if p_usage is null or jsonb_typeof(p_usage)<>'object' then raise exception 'invalid usage'; end if;
  -- Only allowlisted supplier metadata may enter this durable table.
  if exists(select 1 from jsonb_object_keys(p_usage) k where k not in
    ('response_id','model','provider_created','prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens'))
    then raise exception 'unexpected usage field'; end if;
  select * into v from jsonb_populate_record(null::public.classification_usage,p_usage);
  if r.received_at is not null then
    if row(r.response_id,r.model,r.provider_created,r.prompt_tokens,r.completion_tokens,r.total_tokens,r.cached_tokens,r.reasoning_tokens)
       is distinct from row(v.response_id,v.model,v.provider_created,v.prompt_tokens,v.completion_tokens,v.total_tokens,v.cached_tokens,v.reasoning_tokens)
      then raise exception 'usage changed' using detail='classification_conflict'; end if;
    return;
  end if;
  state:=case
    when r.provider='mock' then 'mock'
    when v.prompt_tokens is null and v.completion_tokens is null and v.total_tokens is null then 'missing'
    when v.response_id is not null and v.model is not null
      and v.prompt_tokens+v.completion_tokens=v.total_tokens
      and v.cached_tokens between 0 and v.prompt_tokens
      and (v.reasoning_tokens is null or v.reasoning_tokens between 0 and v.completion_tokens) then 'recorded'
    else 'partial' end;
  update public.classification_usage set received_at=now(),usage_status=state,
    response_id=v.response_id,model=v.model,provider_created=v.provider_created,
    prompt_tokens=v.prompt_tokens,completion_tokens=v.completion_tokens,total_tokens=v.total_tokens,
    cached_tokens=v.cached_tokens,reasoning_tokens=v.reasoning_tokens where classification_id=p_id;
end $$;
revoke all on function public.start_classification_usage(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.record_classification_usage(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.start_classification_usage(uuid,uuid,text,text) to service_role;
grant execute on function public.record_classification_usage(uuid,uuid,jsonb) to service_role;
