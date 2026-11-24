-- A whole video reserves credits once. Its signed segment leases never settle independently.
create table public.library_visual_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id),
  parent_key text not null check (char_length(parent_key) between 16 and 200),
  source_duration_ms bigint not null check (source_duration_ms > 0),
  hold_id uuid not null unique references public.credit_holds(id),
  credits integer not null check (credits > 0),
  pricing_version integer not null,
  finished_status text check (finished_status in ('succeeded', 'failed', 'outcome_unknown')),
  expires_at timestamptz not null,
  unique (user_id, parent_key)
);

create table public.library_visual_segments (
  id uuid primary key default extensions.gen_random_uuid(),
  parent_id uuid not null references public.library_visual_jobs(id),
  user_id uuid not null references public.billing_accounts(id),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  input_manifest_hash text not null check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  video jsonb,
  start_ms bigint not null check (start_ms >= 0),
  end_ms bigint not null check (end_ms > start_ms and end_ms - start_ms <= 7200000),
  status text not null default 'uploading' check (status in ('uploading','queued','leased','running','succeeded','failed','outcome_unknown')),
  lease_id uuid,
  lease_expires_at timestamptz,
  submitted_at timestamptz,
  result_text text check (result_text is null or char_length(result_text) between 1 and 16000),
  error_code text,
  safe_message text,
  provider_receipt jsonb,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (parent_id, start_ms)
);
create index library_visual_segment_claim on public.library_visual_segments (status, created_at)
  where status in ('queued', 'leased', 'running');
create index library_visual_job_expiry on public.library_visual_jobs (expires_at);
alter table public.library_visual_jobs enable row level security;
alter table public.library_visual_segments enable row level security;
revoke all on public.library_visual_jobs, public.library_visual_segments from public, anon, authenticated;
grant select, update on public.library_visual_jobs, public.library_visual_segments to service_role;

-- Exact variable amount, allocated in the same lot order as credit_hold.
create function public.reserve_library_visual_credits(
  p_user_id uuid, p_key text, p_amount integer, p_pricing_version integer, p_expiry timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  hold uuid;
  lot record;
  needed integer := p_amount;
  taken integer;
begin
  if needed is null or needed < 1 then raise exception 'invalid video quote' using errcode = '22023'; end if;
  perform public.ensure_daily_credits(p_user_id, 0);
  perform 1 from public.user_credits where user_id = p_user_id for update;
  if not found then raise exception 'missing credit account' using errcode = '22023'; end if;
  insert into public.credit_holds(user_id,idempotency_key,service,pricing_version,estimated_amount,expires_at)
    values (p_user_id,p_key,'library_video_analysis',p_pricing_version,p_amount,p_expiry)
    returning id into hold;

  for lot in
    select id,remaining_amount from public.credit_lots where user_id = p_user_id
      and remaining_amount > 0 and expires_at > now()
    order by case bucket when 'daily' then 0 when 'sub' then 1 else 2 end,
      expires_at,created_at,id for update
  loop
    exit when needed = 0;
    taken := least(needed, lot.remaining_amount);
    update public.credit_lots set remaining_amount = remaining_amount - taken where id = lot.id;
    insert into public.credit_hold_allocations(user_id,hold_id,lot_id,amount) values (p_user_id,hold,lot.id,taken);
    insert into public.credit_transactions(user_id,hold_id,lot_id,kind,amount,service)
      values (p_user_id,hold,lot.id,'hold',-taken,'library_video_analysis');
    needed := needed - taken;
  end loop;

  if needed <> 0 then raise exception 'insufficient credits' using detail = 'insufficient_credits'; end if;
  perform public.refresh_user_credit_snapshot(p_user_id);
  return hold;
end $$;
revoke all on function public.reserve_library_visual_credits(uuid,text,integer,integer,timestamptz) from public,anon,authenticated,service_role;

create function public.begin_library_visual_segment(
  p_user_id uuid, p_parent_key text, p_segment_key text, p_hash text,
  p_video jsonb, p_expected_credits integer, p_pricing_version integer, p_admission_enabled boolean,
  p_unit_cost_micros numeric, p_daily_limit bigint, p_per_minute integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  parent public.library_visual_jobs;
  segment public.library_visual_segments;
  previous public.library_visual_segments;
  price record;
  quoted numeric;
  hold uuid;
  source_ms bigint := (p_video->>'source_duration_ms')::bigint;
  start_ms bigint := (p_video->>'start_ms')::bigint;
  end_ms bigint := (p_video->>'end_ms')::bigint;
  expiry timestamptz := now() + interval '24 hours';
begin
  if p_parent_key is null or p_segment_key is null or p_parent_key = p_segment_key
      or not starts_with(p_parent_key, 'library-visual:') or not starts_with(p_segment_key, 'library-visual:')
      or length(p_parent_key) not between 16 and 200 or length(p_segment_key) not between 16 and 200
      or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
      or source_ms is null or start_ms is null or end_ms is null
      or start_ms < 0 or end_ms <= start_ms or end_ms > source_ms or mod(start_ms,7200000) <> 0
      or end_ms <> least(start_ms::numeric + 7200000,source_ms) then
    raise exception 'invalid video identity' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_parent_key, 0));
  select * into parent from public.library_visual_jobs where user_id = p_user_id and parent_key = p_parent_key for update;
  select * into segment from public.library_visual_segments where user_id = p_user_id and idempotency_key = p_segment_key;
  if found then
    if segment.parent_id is distinct from parent.id or segment.input_manifest_hash is distinct from p_hash then
      raise exception 'different content' using detail = 'manifest_conflict';
    end if;
    return jsonb_build_object('segment', to_jsonb(segment), 'parent', to_jsonb(parent));
  end if;

  if parent.id is null then
    if not coalesce(p_admission_enabled,false) then raise exception 'video analysis closed' using detail = 'library_visual_closed'; end if;
    if start_ms <> 0 then raise exception 'first segment must start at zero' using errcode = '22023'; end if;
    select cost.unit_cost, cost.pricing_version into price from public.service_costs cost
      where cost.service = 'library_video_analysis' and cost.active and cost.unit_cost > 0
        and cost.parameters->'pricing_ready' = 'true'::jsonb for share;
    if not found then raise exception 'video analysis price unavailable' using detail = 'price_unavailable'; end if;
    quoted := ceil(source_ms::numeric * price.unit_cost / 3600000);
    if quoted > 2147483647 or p_expected_credits is distinct from quoted
        or p_pricing_version is distinct from price.pricing_version then
      raise exception 'stale video analysis quote' using detail = 'stale_quote';
    end if;
    hold := public.reserve_library_visual_credits(p_user_id,p_parent_key,quoted::integer,p_pricing_version,expiry);
    perform public.reserve_managed_usage(p_user_id,hold,ceil(quoted*p_unit_cost_micros)::bigint,p_daily_limit,p_per_minute);
    insert into public.library_visual_jobs(user_id,parent_key,source_duration_ms,hold_id,credits,pricing_version,expires_at)
      values (p_user_id,p_parent_key,source_ms,hold,quoted::integer,p_pricing_version,expiry)
      returning * into parent;
    perform public.mark_hold_pending_settlement(parent.hold_id, 'video analysis accepted');
  else
    if parent.expires_at <= now() or parent.finished_status is not null then raise exception 'video analysis not accepting segments' using detail = 'manifest_conflict'; end if;
    if parent.source_duration_ms is distinct from source_ms or parent.credits is distinct from p_expected_credits
        or parent.pricing_version is distinct from p_pricing_version then
      raise exception 'video analysis quote mismatch' using detail = 'manifest_conflict';
    end if;
    select s.* into previous from public.library_visual_segments s where s.parent_id = parent.id order by s.start_ms desc limit 1;
    if not found or previous.status <> 'succeeded' or previous.end_ms <> start_ms then
      raise exception 'video analysis requires consecutive successful segments' using detail = 'manifest_conflict';
    end if;
  end if;
  insert into public.library_visual_segments(parent_id,user_id,idempotency_key,input_manifest_hash,video,start_ms,end_ms)
    values (parent.id,p_user_id,p_segment_key,p_hash,p_video,start_ms,end_ms)
    returning * into segment;
  return jsonb_build_object('segment', to_jsonb(segment), 'parent', to_jsonb(parent));
end $$;
revoke all on function public.begin_library_visual_segment(uuid,text,text,text,jsonb,integer,integer,boolean,numeric,bigint,integer) from public,anon,authenticated;
grant execute on function public.begin_library_visual_segment(uuid,text,text,text,jsonb,integer,integer,boolean,numeric,bigint,integer) to service_role;

create function public.control_library_visual_segment(
  p_action text, p_segment_id uuid default null, p_user_id uuid default null, p_lease_id uuid default null,
  p_result_text text default null, p_receipt jsonb default null, p_error_code text default null, p_safe_message text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  segment public.library_visual_segments;
  parent public.library_visual_jobs;
  next_status text;
begin
  if p_action = 'claim' then
    select s.* into segment from public.library_visual_segments s
      join public.library_visual_jobs j on j.id = s.parent_id
      where j.finished_status is null and j.expires_at > now() and s.submitted_at is null and
        (s.status = 'queued' or (s.status = 'leased' and s.lease_expires_at <= now()))
      order by s.created_at, s.id for update of s skip locked limit 1;
    if not found then return null; end if;
    update public.library_visual_segments set status = 'leased', lease_id = extensions.gen_random_uuid(),
      lease_expires_at = now() + interval '90 seconds' where id = segment.id returning * into segment;
    return to_jsonb(segment);
  end if;

  select s.* into segment from public.library_visual_segments s where s.id = p_segment_id;
  if not found then raise exception 'missing segment' using errcode = 'P0002'; end if;
  select j.* into parent from public.library_visual_jobs j where j.id = segment.parent_id for update;
  select s.* into segment from public.library_visual_segments s where s.id = p_segment_id for update;
  if p_action in ('commit','reject-upload') then
    if segment.user_id is distinct from p_user_id then raise exception 'missing segment' using errcode = 'P0002'; end if;
    if segment.status = 'uploading' and parent.finished_status is null and parent.expires_at > now() then
      if p_action = 'commit' then
        update public.library_visual_segments set status = 'queued' where id = segment.id returning * into segment;
      else
        perform public.credit_rollback(parent.hold_id, 'library_visual_upload_mismatch');
        update public.library_visual_jobs set finished_status = 'failed' where id = parent.id returning * into parent;
        update public.library_visual_segments set status = 'failed', error_code = 'library_visual_upload_mismatch',
          safe_message = '画面代理文件与原任务不一致' where id = segment.id returning * into segment;
      end if;
    end if;
  elsif p_action = 'expire' then
    if parent.finished_status is null and (parent.expires_at <= now() or
       (segment.status = 'running' and segment.lease_expires_at <= now())) then
      next_status := case when segment.status = 'running' then 'outcome_unknown' else 'failed' end;
      if next_status = 'failed' then perform public.credit_rollback(parent.hold_id, 'library_visual_expired'); end if;
      update public.library_visual_jobs set finished_status = next_status where id = parent.id returning * into parent;
      if segment.status not in ('succeeded','failed','outcome_unknown') then
        update public.library_visual_segments set status = next_status, lease_id = null, lease_expires_at = null,
          error_code = 'library_visual_expired' where id = segment.id returning * into segment;
      end if;
    end if;
  else
    if parent.finished_status is not null or parent.expires_at <= now() or
        segment.lease_id is distinct from p_lease_id or p_lease_id is null or
        segment.lease_expires_at <= now() or segment.status not in ('leased','running') then
      raise exception 'invalid video analysis lease' using errcode = '55000';
    end if;
    if p_action = 'heartbeat' then
      update public.library_visual_segments set lease_expires_at = now() + interval '90 seconds'
        where id = segment.id returning * into segment;
    elsif p_action = 'submitted' and segment.status = 'leased' and segment.submitted_at is null then
      update public.library_visual_segments set status = 'running', submitted_at = now()
        where id = segment.id returning * into segment;
    elsif p_action in ('finish','fail','unknown') then
      if p_action = 'finish' and (segment.submitted_at is null or p_result_text is null or
          length(btrim(p_result_text)) not between 1 and 16000) then raise exception 'invalid video analysis result' using errcode = '22023'; end if;
      if p_receipt is not null and (jsonb_typeof(p_receipt) <> 'object' or octet_length(p_receipt::text) > 32000) then
        raise exception 'invalid video usage receipt' using errcode = '22023';
      end if;
      next_status := case p_action when 'finish' then 'succeeded' when 'fail' then 'failed' else 'outcome_unknown' end;
      update public.library_visual_segments set status = next_status, result_text = p_result_text,
        provider_receipt = p_receipt, error_code = left(p_error_code,80), safe_message = left(p_safe_message,500),
        lease_id = null, lease_expires_at = null where id = segment.id returning * into segment;
      if next_status = 'failed' then perform public.credit_rollback(parent.hold_id, coalesce(p_error_code, 'library_visual_failed')); end if;
      if next_status <> 'succeeded' or segment.end_ms = parent.source_duration_ms then
        if next_status = 'succeeded' then perform public.credit_confirm(parent.hold_id, parent.credits); end if;
        update public.library_visual_jobs set finished_status = next_status where id = parent.id returning * into parent;
      end if;
    else raise exception 'invalid video analysis action' using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object('segment', to_jsonb(segment), 'parent', to_jsonb(parent));
end $$;
revoke all on function public.control_library_visual_segment(text,uuid,uuid,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.control_library_visual_segment(text,uuid,uuid,uuid,text,jsonb,text,text) to service_role;

-- Investigate the provider request or retained usage receipt before resolving.
-- An unknown Ark request is never replayed or charged to a user without a deliverable.
create function public.refund_unknown_library_visual(p_parent_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare parent public.library_visual_jobs;
begin
  if p_reason is null or length(btrim(p_reason)) not between 5 and 160 then
    raise exception 'operator refund requires an audit reason' using errcode = '22023';
  end if;
  select * into parent from public.library_visual_jobs where id = p_parent_id for update;
  if not found or parent.finished_status is distinct from 'outcome_unknown' then return false; end if;
  perform public.credit_rollback(parent.hold_id, 'library_visual_operator:' || p_reason);
  update public.library_visual_jobs set finished_status = 'failed' where id = parent.id;
  update public.library_visual_segments set status = 'failed', error_code = 'library_visual_reconciled',
    safe_message = '画面分析未完成，预留积分已退还' where parent_id = parent.id and status = 'outcome_unknown';
  return true;
end $$;
revoke all on function public.refund_unknown_library_visual(uuid,text) from public,anon,authenticated;
grant execute on function public.refund_unknown_library_visual(uuid,text) to service_role;
