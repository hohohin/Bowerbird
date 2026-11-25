-- Isolated, millibcoin-priced shot service. Existing clients retain the whole-unit projections.
insert into public.service_costs(service,unit_cost,pricing_version,active,parameters)
values ('library_video_shot_analysis',0,20261124,false,
  '{"pricing_ready":false,"short_milli":54,"long_milli":134,"max_ms":60000}');

alter table public.credit_lots add column remaining_milli smallint not null default 0
  check (remaining_milli between 0 and 999 and (remaining_milli=0 or remaining_amount<original_amount));
alter table public.credit_holds add column estimated_milli integer;
alter table public.credit_holds drop constraint credit_holds_estimated_amount_check;
alter table public.credit_holds add constraint credit_holds_estimated_amount_check check (
  (service='library_video_shot_analysis' and estimated_amount=0 and estimated_milli is not null and estimated_milli between 1 and 999
   and coalesce(actual_amount,0)=0)
  or (service<>'library_video_shot_analysis' and estimated_milli is null and
      (estimated_amount>0 or (service='chat_deepseek' and estimated_amount=0))));

-- Amount on a shot transaction is the change in the legacy whole-unit projection.
-- amount_milli in meta records the exact debit. Original lot and expiry never change.
create view public.wallet_balances_milli with (security_invoker=true) as
select user_id,coalesce(sum(remaining_amount::bigint*1000+remaining_milli) filter(where bucket='daily'),0)::bigint as daily,
       coalesce(sum(remaining_amount::bigint*1000+remaining_milli) filter(where bucket='sub'),0)::bigint as sub,
       coalesce(sum(remaining_amount::bigint*1000+remaining_milli) filter(where bucket='topup'),0)::bigint as topup
from public.credit_lots where expires_at>now() group by user_id;
revoke all on public.wallet_balances_milli from public,anon,authenticated;
grant select on public.wallet_balances_milli to service_role;

create function public.refund_shot_milli() returns trigger language plpgsql security definer set search_path='' as $$
declare debit record; previous_milli integer; units integer; amount_m integer;
begin
  for debit in select lot_id,meta from public.credit_transactions where hold_id=new.id and kind='hold' order by lot_id loop
    amount_m := -(debit.meta->>'amount_milli')::integer;
    select remaining_milli into strict previous_milli from public.credit_lots where id=debit.lot_id for update;
    units := (previous_milli+amount_m)/1000;
    update public.credit_lots set remaining_amount=remaining_amount+units,remaining_milli=(previous_milli+amount_m)%1000 where id=debit.lot_id;
    insert into public.credit_transactions(user_id,hold_id,lot_id,kind,amount,service,meta)
      values(new.user_id,new.id,debit.lot_id,'rollback',units,new.service,jsonb_build_object('amount_milli',amount_m,'reason',new.reason));
  end loop;
  return null;
end $$;
revoke all on function public.refund_shot_milli() from public,anon,authenticated,service_role;
create trigger refund_shot_milli after update of status on public.credit_holds for each row
  when (new.service='library_video_shot_analysis' and new.status='rolled_back' and old.status<>new.status)
  execute function public.refund_shot_milli();

create table public.library_shot_jobs (
 id uuid primary key default extensions.gen_random_uuid(),
 user_id uuid not null references public.billing_accounts(id), idempotency_key text not null,
 hold_id uuid not null unique references public.credit_holds(id), amount_milli integer not null, pricing_version integer not null,
 input_manifest_hash text not null, source_sha256 text not null, video jsonb, result_text text, provider_receipt jsonb,
 status text not null default 'uploading' check(status in ('uploading','queued','leased','running','succeeded','failed','outcome_unknown')),
 lease_id uuid, lease_expires_at timestamptz, submitted_at timestamptz, error_code text, safe_message text,
 cleaned_at timestamptz, created_at timestamptz not null default now(), expires_at timestamptz not null default(now()+interval '24 hours'),
 unique(user_id,idempotency_key));
create index library_shot_claim on public.library_shot_jobs(status,created_at) where status in ('queued','leased','running');
create index library_shot_expiry on public.library_shot_jobs(expires_at) where cleaned_at is null;
alter table public.library_shot_jobs enable row level security;
revoke all on public.library_shot_jobs from public,anon,authenticated;
grant select,update on public.library_shot_jobs to service_role;

create function public.begin_library_shot(p_user_id uuid,p_key text,p_source_sha256 text,p_hash text,p_video jsonb,
  p_expected_milli integer,p_pricing_version integer,p_enabled boolean,p_unit_cost_micros numeric,p_daily_limit bigint,p_per_minute integer)
returns public.library_shot_jobs language plpgsql security definer set search_path='' as $$
declare job public.library_shot_jobs; cost public.service_costs; hold uuid; lot record;
  needed integer; take_m integer; units integer; delta bigint := (p_video->>'end_ms')::bigint - (p_video->>'start_ms')::bigint;
begin
  if p_key is null or not starts_with(p_key,'library-shot:') or length(p_key) not between 16 and 200 or
    coalesce(p_source_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or
    delta is null or delta not between 1 and 60000 then raise exception 'invalid shot identity' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_key,0));
  select * into job from public.library_shot_jobs where user_id=p_user_id and idempotency_key=p_key;
  if found then
    if job.input_manifest_hash<>p_hash or job.source_sha256<>p_source_sha256 then raise exception 'different shot' using detail='manifest_conflict'; end if;
    return job;
  end if;
  select * into cost from public.service_costs where service='library_video_shot_analysis' and active and parameters->'pricing_ready'='true'::jsonb for share;
  if not found or p_enabled is not true or coalesce(p_unit_cost_micros,0)<=0 then
    raise exception 'shot pricing closed' using detail='price_unavailable';
  end if;
  needed := (cost.parameters->>(case when delta<=15000 then 'short_milli' else 'long_milli' end))::integer;
  if needed is null or needed not between 1 and 999 or needed is distinct from p_expected_milli or cost.pricing_version is distinct from p_pricing_version then
    raise exception 'shot price changed' using detail='stale_quote'; end if;
  perform public.ensure_daily_credits(p_user_id,0);
  perform 1 from public.user_credits where user_id=p_user_id for update;
  insert into public.credit_holds(user_id,idempotency_key,service,pricing_version,estimated_amount,estimated_milli,expires_at)
    values (p_user_id,p_key,cost.service,cost.pricing_version,0,needed,now()+interval '24 hours') returning id into hold;
  for lot in select * from public.credit_lots where user_id=p_user_id and expires_at>now() and (remaining_amount>0 or remaining_milli>0)
    order by case bucket when 'daily' then 0 when 'sub' then 1 else 2 end,expires_at,created_at,id for update loop
    take_m := least(needed,lot.remaining_amount::bigint*1000+lot.remaining_milli);
    units := case when take_m>lot.remaining_milli then 1 else 0 end;
    update public.credit_lots set remaining_amount=remaining_amount-units, remaining_milli=remaining_milli+1000*units-take_m where id=lot.id;
    insert into public.credit_transactions(user_id,hold_id,lot_id,kind,amount,service,meta)
      values(p_user_id,hold,lot.id,'hold',-units,cost.service,jsonb_build_object('amount_milli',-take_m));
    needed := needed-take_m;
    exit when needed=0;
  end loop;
  if needed<>0 then raise exception 'insufficient shot balance' using detail='insufficient_credits'; end if;
  perform public.reserve_managed_usage(p_user_id,hold,ceil(p_expected_milli*p_unit_cost_micros/1000)::bigint,p_daily_limit,p_per_minute);
  perform public.mark_hold_pending_settlement(hold,'shot accepted');
  perform public.refresh_user_credit_snapshot(p_user_id);
  insert into public.library_shot_jobs(user_id,idempotency_key,hold_id,amount_milli,pricing_version,input_manifest_hash,source_sha256,video)
    values(p_user_id,p_key,hold,p_expected_milli,cost.pricing_version,p_hash,p_source_sha256,p_video) returning * into job;
  return job;
end $$;
revoke all on function public.begin_library_shot(uuid,text,text,text,jsonb,integer,integer,boolean,numeric,bigint,integer) from public,anon,authenticated;
grant execute on function public.begin_library_shot(uuid,text,text,text,jsonb,integer,integer,boolean,numeric,bigint,integer) to service_role;

create function public.control_library_shot(p_action text,p_segment_id uuid default null,p_user_id uuid default null,
 p_lease_id uuid default null,p_result_text text default null,p_receipt jsonb default null,p_error_code text default null,p_safe_message text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.library_shot_jobs; next_status text; fields jsonb;
begin
 if p_action='claim' then
   select * into job from public.library_shot_jobs where expires_at>now() and submitted_at is null and
     (status='queued' or (status='leased' and lease_expires_at<=now())) order by created_at,id for update skip locked limit 1;
   if not found then return null; end if;
   update public.library_shot_jobs set status='leased',lease_id=extensions.gen_random_uuid(),lease_expires_at=now()+interval '90 seconds' where id=job.id returning * into job;
   return to_jsonb(job);
 end if;
 select * into strict job from public.library_shot_jobs where id=p_segment_id for update;
 if p_action in ('commit','reject-upload') then
   if job.user_id is distinct from p_user_id then raise exception 'shot not found' using errcode='P0002'; end if;
   if job.status='uploading' and job.expires_at>now() then next_status := case when p_action='commit' then 'queued' else 'failed' end; end if;
 elsif p_action='expire' then
   if job.status not in ('succeeded','failed','outcome_unknown') and (job.expires_at<=now() or (job.status='running' and job.lease_expires_at<=now())) then
     next_status := case when job.submitted_at is null then 'failed' else 'outcome_unknown' end;
   end if;
 elsif p_action='refund-unknown' then
   if job.status='outcome_unknown' and length(trim(p_safe_message)) between 5 and 160 then next_status:='failed'; end if;
 else
   if job.status not in ('leased','running') or job.lease_id is distinct from p_lease_id or p_lease_id is null or
      job.expires_at<=now() or job.lease_expires_at<=now() then raise exception 'shot lease lost' using errcode='55000'; end if;
   if p_action='heartbeat' then
     update public.library_shot_jobs set lease_expires_at=now()+interval '90 seconds' where id=job.id returning * into job;
   elsif p_action='submitted' and job.status='leased' then
     update public.library_shot_jobs set status='running',submitted_at=now() where id=job.id returning * into job;
   elsif p_action='finish' and job.submitted_at is not null and length(p_result_text) between 1 and 16000 then
     fields := p_result_text::jsonb;
     if jsonb_typeof(fields) is distinct from 'object' or exists (
        select 1 from unnest(array['description','first_frame_prompt','motion_prompt']) as field(key)
        where jsonb_typeof(fields->key) is distinct from 'string' or length(trim(fields->>key))=0
     ) or jsonb_typeof(p_receipt#>'{usage,prompt_tokens}') is distinct from 'number'
       or jsonb_typeof(p_receipt#>'{usage,completion_tokens}') is distinct from 'number' then
       raise exception 'missing shot result or usage' using errcode='22023';
     end if;
     next_status:='succeeded';
   elsif p_action='unknown' and job.submitted_at is not null then next_status:='outcome_unknown';
   elsif p_action='fail' then next_status:='failed';
   else raise exception 'invalid shot transition' using errcode='22023'; end if;
 end if;
 if next_status is not null then
   if next_status='succeeded' then perform public.credit_confirm(job.hold_id,0);
   elsif next_status='failed' then
     perform public.credit_rollback(job.hold_id,
       case when p_action='refund-unknown' then 'shot_operator:'||trim(p_safe_message) else coalesce(p_error_code,p_action) end);
   end if;
   if p_action='refund-unknown' then p_safe_message:='镜头未能交付，预留积分已退还'; p_error_code:='reconciled_refund';
   elsif p_action='reject-upload' then p_safe_message:='镜头代理与原任务不一致'; p_error_code:='upload_mismatch';
   elsif p_action='expire' then p_error_code:='shot_expired'; end if;
   update public.library_shot_jobs set status=next_status,lease_id=null,lease_expires_at=null,result_text=p_result_text,
     provider_receipt=coalesce(p_receipt,provider_receipt),error_code=left(p_error_code,80),safe_message=left(p_safe_message,500)
     where id=job.id returning * into job;
 end if;
 return jsonb_build_object('segment',to_jsonb(job));
end $$;
revoke all on function public.control_library_shot(text,uuid,uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.control_library_shot(text,uuid,uuid,uuid,text,jsonb,text,text) to service_role;
