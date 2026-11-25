-- Adding this migration does not enable a catalog price or assign a pilot.
-- Keep the speech service's independent restrictive policy intact.
create policy service_costs_hide_library_shot_pilot on public.service_costs
as restrictive for select to anon, authenticated
using (service <> 'library_video_shot_analysis' or (
  not (parameters ? 'pilot_user_id')
  and coalesce(parameters->'pilot_only','false'::jsonb) = 'false'::jsonb
));

-- The service role supplies the verified subject. No identity or private catalog parameters
-- leave this boundary. The reservation holds the same catalog lock until commit.
create function public.library_shot_price(p_user_id uuid,p_public_enabled boolean)
returns table(service text,pricing_version integer,short_milli integer,long_milli integer)
language sql stable security definer set search_path='' as $$
  select c.service,c.pricing_version,(c.parameters->>'short_milli')::integer,(c.parameters->>'long_milli')::integer
  from public.service_costs c
  where c.service='library_video_shot_analysis' and c.active and p_user_id is not null
    and c.parameters->'pricing_ready'='true'::jsonb and c.pricing_version>0
    and jsonb_typeof(c.parameters->'short_milli')='number' and (c.parameters->>'short_milli') ~ '^[1-9][0-9]{0,2}$'
    and jsonb_typeof(c.parameters->'long_milli')='number' and (c.parameters->>'long_milli') ~ '^[1-9][0-9]{0,2}$'
    and case when c.parameters->'pilot_only'='true'::jsonb
      then c.parameters->>'pilot_user_id'=p_user_id::text
      else p_public_enabled is true and not (c.parameters ? 'pilot_user_id')
        and coalesce(c.parameters->'pilot_only','false'::jsonb)='false'::jsonb
    end;
$$;
revoke all on function public.library_shot_price(uuid,boolean) from public,anon,authenticated;
grant execute on function public.library_shot_price(uuid,boolean) to service_role;

create or replace function public.begin_library_shot(p_user_id uuid,p_key text,p_source_sha256 text,p_hash text,p_video jsonb,
  p_expected_milli integer,p_pricing_version integer,p_enabled boolean,p_unit_cost_micros numeric,p_daily_limit bigint,p_per_minute integer)
returns public.library_shot_jobs language plpgsql security definer set search_path='' as $$
declare job public.library_shot_jobs; cost record; hold uuid; lot record;
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
  perform 1 from public.service_costs where service='library_video_shot_analysis' for share;
  select * into cost from public.library_shot_price(p_user_id,p_enabled);
  if not found or coalesce(p_unit_cost_micros,0)<=0 then
    raise exception 'shot pricing closed' using detail='price_unavailable';
  end if;
  needed := case when delta<=15000 then cost.short_milli else cost.long_milli end;
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
