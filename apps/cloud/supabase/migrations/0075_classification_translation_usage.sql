-- Translation is a separate supplier operation within the same billed image.
-- Keep the discovery ledger untouched; neither table retains label/prompt text.
create table public.classification_translation_usage (
  like public.classification_usage including defaults including constraints,
  batch_index integer not null check(batch_index between 0 and 253),
  primary key(classification_id,batch_index),
  foreign key(classification_id) references public.classification_requests(id),
  foreign key(user_id) references public.billing_accounts(id)
);
create index classification_translation_usage_user_time on public.classification_translation_usage(user_id,started_at);
create index classification_translation_usage_pending on public.classification_translation_usage(started_at) where usage_status='pending';
alter table public.classification_translation_usage enable row level security;
alter table public.classification_translation_usage force row level security;
revoke all on public.classification_translation_usage from public,anon,authenticated;
grant select on public.classification_translation_usage to service_role;

create function public.start_classification_translation_usage(p_user_id uuid,p_id uuid,p_batch integer,p_provider text,p_requested_model text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  perform 1 from public.classification_requests where id=p_id and user_id=p_user_id and status='judging' for update;
  if not found then raise exception 'judge missing' using detail='classification_conflict'; end if;
  insert into public.classification_translation_usage(classification_id,user_id,batch_index,provider,requested_model)
    values(p_id,p_user_id,p_batch,p_provider,p_requested_model) on conflict(classification_id,batch_index) do nothing;
  get diagnostics n=row_count;
  return n=1;
end $$;

create function public.record_classification_translation_usage(p_user_id uuid,p_id uuid,p_batch integer,p_usage jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare r public.classification_translation_usage; v public.classification_translation_usage; state text;
begin
  select * into r from public.classification_translation_usage where classification_id=p_id and batch_index=p_batch and user_id=p_user_id for update;
  if not found then raise exception 'usage missing' using detail='classification_conflict'; end if;
  if p_usage is null or jsonb_typeof(p_usage)<>'object' then raise exception 'invalid usage'; end if;
  -- Only allowlisted supplier metadata may enter this durable table.
  if exists(select 1 from jsonb_object_keys(p_usage) k where k not in
    ('response_id','model','provider_created','prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens'))
    then raise exception 'unexpected usage field'; end if;
  select * into v from jsonb_populate_record(null::public.classification_translation_usage,p_usage);
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
  update public.classification_translation_usage set received_at=now(),usage_status=state,
    response_id=v.response_id,model=v.model,provider_created=v.provider_created,
    prompt_tokens=v.prompt_tokens,completion_tokens=v.completion_tokens,total_tokens=v.total_tokens,
    cached_tokens=v.cached_tokens,reasoning_tokens=v.reasoning_tokens where classification_id=p_id and batch_index=p_batch;
end $$;
revoke all on function public.start_classification_translation_usage(uuid,uuid,integer,text,text) from public,anon,authenticated;
revoke all on function public.record_classification_translation_usage(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.start_classification_translation_usage(uuid,uuid,integer,text,text) to service_role;
grant execute on function public.record_classification_translation_usage(uuid,uuid,integer,jsonb) to service_role;

-- Short-lived translated text only. Original images/requests never enter this cache.
create table public.classification_preparations (
  classification_id uuid primary key references public.classification_requests(id),
  user_id uuid not null references public.billing_accounts(id),
  batch_count integer not null check(batch_count between 1 and 254),
  results jsonb not null default '{}' check(jsonb_typeof(results)='object'),
  jev_started boolean not null default false
);
alter table public.classification_preparations enable row level security;
alter table public.classification_preparations force row level security;
revoke all on public.classification_preparations from public,anon,authenticated;

create function public.claim_classification_preparation(p_user_id uuid,p_id uuid,p_batch_count integer,p_provider text,p_requested_model text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.classification_requests; c public.classification_preparations; held public.credit_holds; v jsonb; n integer; claimed boolean;
begin
  -- Same wallet-first order as classification settlement. Active preparation
  -- owns its reservation until success or the classification inactivity cleanup.
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into r from public.classification_requests where id=p_id and user_id=p_user_id for update;
  if not found or r.status<>'judging' or r.updated_at<now()-interval '10 minutes' then
    raise exception 'preparation unavailable' using detail='classification_conflict'; end if;
  select * into held from public.mark_hold_pending_settlement(r.hold_id,'classification rule preparation');
  if held.status<>'pending_settlement' then raise exception 'classification hold unavailable' using detail='classification_conflict'; end if;
  insert into public.classification_preparations(classification_id,user_id,batch_count)
    values(p_id,p_user_id,p_batch_count) on conflict(classification_id) do nothing;
  select * into c from public.classification_preparations where classification_id=p_id for update;
  if c.user_id<>p_user_id or c.batch_count<>p_batch_count then
    raise exception 'preparation changed' using detail='classification_conflict'; end if;
  select coalesce(jsonb_agg(item.value),'[]'::jsonb) into v
    from jsonb_each(c.results) batch cross join lateral jsonb_array_elements(batch.value) item;
  select count(*)::integer into n from jsonb_object_keys(c.results);
  if n=c.batch_count then
    if c.jev_started then return jsonb_build_object('phase','busy','translations',v); end if;
    update public.classification_preparations set jev_started=true where classification_id=p_id;
    update public.classification_requests set updated_at=now() where id=p_id;
    return jsonb_build_object('phase','judge','translations',v);
  end if;
  claimed:=public.start_classification_translation_usage(p_user_id,p_id,n,p_provider,p_requested_model);
  if claimed then update public.classification_requests set updated_at=now() where id=p_id; end if;
  return jsonb_build_object('phase',case when claimed then 'translate' else 'busy' end,'batch',n,'translations',v);
end $$;

create function public.finish_classification_preparation(p_user_id uuid,p_id uuid,p_batch integer,p_translations jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.classification_preparations; v jsonb;
begin
  perform 1 from public.classification_requests where id=p_id and user_id=p_user_id and status='judging' for update;
  if not found then raise exception 'preparation unavailable' using detail='classification_conflict'; end if;
  select * into c from public.classification_preparations where classification_id=p_id and user_id=p_user_id for update;
  if not found or c.jev_started or p_batch<0 or p_batch>=c.batch_count or
    p_translations is null or jsonb_typeof(p_translations)<>'array' or jsonb_array_length(p_translations) not between 1 and 4 or
    not exists(select 1 from public.classification_translation_usage where classification_id=p_id and batch_index=p_batch and received_at is not null) then
    raise exception 'preparation result invalid' using detail='classification_conflict'; end if;
  if c.results ? p_batch::text then
    if c.results->p_batch::text<>p_translations then raise exception 'preparation result changed' using detail='classification_conflict'; end if;
  else
    c.results:=jsonb_set(c.results,array[p_batch::text],p_translations);
    update public.classification_preparations set results=c.results where classification_id=p_id;
  end if;
  update public.classification_requests set updated_at=now() where id=p_id;
  select coalesce(jsonb_agg(item.value),'[]'::jsonb) into v
    from jsonb_each(c.results) batch cross join lateral jsonb_array_elements(batch.value) item;
  return v;
end $$;

create function public.clear_classification_preparation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status<>'judging' then delete from public.classification_preparations where classification_id=new.id; end if;
  return new;
end $$;
create trigger clear_classification_preparation after update of status on public.classification_requests
  for each row execute function public.clear_classification_preparation();

-- An actively progressing large vocabulary may take longer than ten minutes.
-- Retain the existing settlement implementation and expire only inactive work.
do $$
declare definition text; old text:='r.created_at<now()-interval ''10 minutes''';
begin
  select pg_get_functiondef('public.advance_classification(uuid,uuid,text,text,text,jsonb,boolean)'::regprocedure) into definition;
  if length(definition)-length(replace(definition,old,''))<>length(old) then raise exception 'classification expiry anchor missing or duplicated'; end if;
  execute replace(definition,old,'r.updated_at<now()-interval ''10 minutes''');
end $$;

revoke all on function public.claim_classification_preparation(uuid,uuid,integer,text,text) from public,anon,authenticated;
revoke all on function public.finish_classification_preparation(uuid,uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.clear_classification_preparation() from public,anon,authenticated;
grant execute on function public.claim_classification_preparation(uuid,uuid,integer,text,text) to service_role;
grant execute on function public.finish_classification_preparation(uuid,uuid,integer,jsonb) to service_role;
