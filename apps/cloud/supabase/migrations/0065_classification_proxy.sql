-- One billable image = a validated Jev match OR a validated Cloud label result.
-- Five successes across requests/batches cost one credit; no fractional wallets.
insert into public.service_costs(service,unit_cost,parameters)
values ('classification',1,'{"images_per_credit":5}') on conflict(service) do nothing;

create table public.classification_meters (
  user_id uuid primary key references public.billing_accounts(id),
  successful_images bigint not null default 0 check(successful_images >= 0)
);
create table public.classification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id),
  request_key text not null,
  input_hash text not null,
  image_hash text not null,
  hold_id uuid not null references public.credit_holds(id),
  status text not null check(status in ('judging','needs_discovery','discovering','succeeded','undetermined','failed')),
  allow_discovery boolean not null,
  quota_date date,
  judge_response jsonb,
  discovery_hash text,
  discovery_response jsonb,
  charged integer not null default 0 check(charged in (0,1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,request_key)
);
create index classification_pending_expiry on public.classification_requests(updated_at)
  where status in ('judging','needs_discovery','discovering');
alter table public.classification_meters enable row level security;
alter table public.classification_meters force row level security;
alter table public.classification_requests enable row level security;
alter table public.classification_requests force row level security;
revoke all on public.classification_meters,public.classification_requests from public,anon,authenticated;

create function public.begin_classification(p_user_id uuid,p_key text,p_input_hash text,p_image_hash text,
  p_allow_discovery boolean,p_cost_micros bigint,p_daily_limit bigint,p_rate_limit integer,p_free_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.classification_requests; h record; qdate date;
begin
  -- Wallet first in all transitions: same lock order as credit_confirm/rollback.
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into r from public.classification_requests where user_id=p_user_id and request_key=p_key for update;
  if found then
    if r.input_hash<>p_input_hash then raise exception 'classification input changed' using detail='classification_conflict'; end if;
    return jsonb_build_object('claimed',false,'request',to_jsonb(r));
  end if;
  select * into h from public.credit_hold(p_user_id,'classification:'||p_key,'classification',1);
  perform public.reserve_managed_usage(p_user_id,h.hold_id,p_cost_micros,p_daily_limit,p_rate_limit);
  if p_free_limit is not null then
    qdate:=timezone('Asia/Shanghai',now())::date;
    perform public.consume_understand_quota(p_user_id,p_free_limit,qdate);
  end if;
  insert into public.classification_requests(user_id,request_key,input_hash,image_hash,hold_id,status,allow_discovery,quota_date)
  values(p_user_id,p_key,p_input_hash,p_image_hash,h.hold_id,'judging',p_allow_discovery,qdate) returning * into r;
  return jsonb_build_object('claimed',true,'request',to_jsonb(r));
end $$;

create function public.advance_classification(p_user_id uuid,p_id uuid,p_action text,p_image_hash text default null,
  p_hash text default null,p_response jsonb default null,p_success boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.classification_requests; n bigint; amount integer:=0;
begin
  perform 1 from public.user_credits where user_id=p_user_id for update;
  select * into r from public.classification_requests where id=p_id and user_id=p_user_id for update;
  if not found then raise exception 'classification missing' using detail='classification_conflict'; end if;
  if p_action='claim_discovery' then
    if r.image_hash<>p_image_hash or not r.allow_discovery or
      (r.discovery_hash is not null and r.discovery_hash<>p_hash) then
      raise exception 'classification input changed' using detail='classification_conflict';
    end if;
    if r.status<>'needs_discovery' then return jsonb_build_object('claimed',false,'request',to_jsonb(r)); end if;
    if r.created_at<now()-interval '10 minutes' then raise exception 'classification expired' using detail='classification_conflict'; end if;
    update public.classification_requests set status='discovering',discovery_hash=p_hash,updated_at=now() where id=r.id returning * into r;
    return jsonb_build_object('claimed',true,'request',to_jsonb(r));
  end if;
  if r.status in ('succeeded','undetermined','failed') then return to_jsonb(r); end if;
  if p_action='await_discovery' and r.status='judging' and r.allow_discovery then
    update public.classification_requests set status='needs_discovery',judge_response=p_response,updated_at=now() where id=r.id returning * into r;
    return to_jsonb(r);
  end if;
  if p_action not in ('judge_done','discovery_done','fail') or
    (p_action='judge_done' and r.status<>'judging') or (p_action='discovery_done' and r.status<>'discovering') then
    raise exception 'invalid classification transition' using detail='classification_conflict';
  end if;
  if p_action<>'fail' and p_success then
    insert into public.classification_meters as m(user_id,successful_images) values(p_user_id,1)
    on conflict(user_id) do update set successful_images=m.successful_images+1 returning successful_images into n;
    amount:=case when n%5=0 then 1 else 0 end;
    perform public.credit_confirm(r.hold_id,amount);
  else
    -- The generic hold sweeper may already have refunded an abandoned request.
    if exists(select 1 from public.credit_holds where id=r.hold_id and status in ('held','pending_settlement')) then
      perform public.credit_rollback(r.hold_id,'classification_without_labels');
    end if;
    if r.quota_date is not null then perform public.undo_understand_quota(p_user_id,r.quota_date); end if;
  end if;
  update public.classification_requests set
    status=case when p_action='fail' then 'failed' when p_success then 'succeeded' else 'undetermined' end,
    judge_response=case when p_action='judge_done' then p_response else judge_response end,
    discovery_response=case when p_action='discovery_done' then p_response else discovery_response end,
    charged=amount,updated_at=now() where id=r.id returning * into r;
  return to_jsonb(r);
end $$;

-- Called by the existing scheduled maintenance endpoint, also before new work.
create function public.cleanup_classification() returns void language plpgsql security definer set search_path='' as $$
declare r record;
begin
  for r in select id,user_id from public.classification_requests
    where status in ('judging','needs_discovery','discovering') and updated_at<now()-interval '10 minutes'
    order by user_id,id limit 100
  loop
    perform public.advance_classification(r.user_id,r.id,'fail');
  end loop;
  update public.classification_requests set judge_response=null,discovery_response=null
    where created_at<now()-interval '1 day' and (judge_response is not null or discovery_response is not null);
end $$;
revoke all on function public.begin_classification(uuid,text,text,text,boolean,bigint,bigint,integer,integer) from public,anon,authenticated;
revoke all on function public.advance_classification(uuid,uuid,text,text,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.cleanup_classification() from public,anon,authenticated;
grant execute on function public.begin_classification(uuid,text,text,text,boolean,bigint,bigint,integer,integer) to service_role;
grant execute on function public.advance_classification(uuid,uuid,text,text,text,jsonb,boolean) to service_role;
grant execute on function public.cleanup_classification() to service_role;
