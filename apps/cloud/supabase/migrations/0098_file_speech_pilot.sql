-- Keep the existing permissive catalog policy and its 0096 exclusions intact.
create policy service_costs_hide_file_speech_pilot on public.service_costs
as restrictive for select to anon, authenticated
using (service <> 'library_file_speech' or parameters->'pilot_only' is distinct from 'true'::jsonb);

alter table public.understand_jobs add column file_speech_pilot boolean not null default false,
  add constraint understand_jobs_file_speech_pilot_check check (
    not file_speech_pilot or operation = 'file-speech-transcription'
  );
create unique index understand_jobs_single_file_speech_pilot on public.understand_jobs (user_id)
where file_speech_pilot;

-- The Edge passes a mode derived from verified Auth. NULL may only find the original job.
create function public.begin_file_speech_upload(
  p_user_id uuid, p_key text, p_hash text, p_expected_credits integer,
  p_unit_cost_micros numeric, p_daily_limit bigint, p_per_minute integer,
  p_source_duration_ms integer, p_pilot boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.understand_jobs;
  held record;
  job_id uuid := extensions.gen_random_uuid();
  accepted public.understand_jobs;
  current_price integer;
begin
  if p_key is null or char_length(p_key) not between 13 and 200 or not starts_with(p_key, 'file-speech:')
      or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
      or p_source_duration_ms is null or p_source_duration_ms not between 1 and 7200000 then
    raise exception 'invalid file speech input identity' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_key, 0));
  select job.* into existing from public.understand_jobs as job
    where job.user_id = p_user_id and job.idempotency_key = p_key;
  if found then
    if existing.operation <> 'file-speech-transcription' or existing.input_manifest_hash is distinct from p_hash
        or existing.file_speech_source_duration_ms is distinct from p_source_duration_ms then
      raise exception 'different content' using errcode = '22023', detail = 'manifest_conflict';
    end if;
    if existing.status = 'uploading' then
      return public.transition_text_upload('public.understand_jobs'::regclass, existing.id, p_hash, false);
    end if;
    return to_jsonb(existing);
  end if;

  if p_pilot is null then
    raise exception 'file speech closed' using detail = 'file_speech_closed';
  end if;

  select cost.unit_cost into current_price from public.service_costs as cost
    where cost.service = 'library_file_speech' and cost.active and cost.unit_cost > 0
      and cost.parameters->'pricing_ready' = 'true'::jsonb
      and (cost.parameters->'pilot_only' is not distinct from 'true'::jsonb) = p_pilot for share;
  if not found then
    raise exception 'file speech price unavailable' using detail = 'price_unavailable';
  end if;
  if p_expected_credits is distinct from current_price then
    raise exception 'stale file speech quote' using errcode = '22023', detail = 'stale_quote';
  end if;

  if p_pilot then
    perform pg_advisory_xact_lock(hashtextextended('file-speech-pilot:' || p_user_id::text, 0));
    if exists(select 1 from public.understand_jobs where user_id = p_user_id and file_speech_pilot) then
      raise exception 'file speech pilot already used' using detail = 'file_speech_pilot_used';
    end if;
  end if;

  perform public.ensure_daily_credits(p_user_id, 0);
  select * into strict held from public.credit_hold(p_user_id, p_key, 'library_file_speech', p_expected_credits);
  if held.status <> 'held' or exists(
    select 1 from public.credit_holds where id = held.hold_id and reserved_cost_micros is not null
  ) then
    raise exception 'key already accepted' using detail = 'key_in_use';
  end if;
  perform public.reserve_managed_usage(p_user_id, held.hold_id,
    case when p_pilot then 2000000 else ceil(held.estimated_amount * p_unit_cost_micros)::bigint end,
    p_daily_limit, p_per_minute);
  insert into public.understand_jobs as job(
    id, user_id, idempotency_key, input_manifest_hash, operation, request_object_key,
    hold_id, estimated_credits, pricing_version, content_expires_at, file_speech_source_duration_ms, file_speech_pilot
  ) values (
    job_id, p_user_id, p_key, p_hash, 'file-speech-transcription', 'understand/' || job_id::text || '/inputs/request.json',
    held.hold_id, held.estimated_amount, held.pricing_version, now() + interval '24 hours', p_source_duration_ms, p_pilot
  ) returning job.* into accepted;
  return to_jsonb(accepted);
end $$;

revoke all on function public.begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.begin_file_speech_upload(uuid,text,text,integer,numeric,bigint,integer,integer,boolean) to service_role;

-- Existing Edge packages keep the eight named parameters and can only use public pricing.
create or replace function public.begin_file_speech_upload(
  p_user_id uuid, p_key text, p_hash text, p_expected_credits integer,
  p_unit_cost_micros numeric, p_daily_limit bigint, p_per_minute integer,
  p_source_duration_ms integer
) returns jsonb language sql security definer set search_path = '' as $$
  select public.begin_file_speech_upload(p_user_id, p_key, p_hash, p_expected_credits,
    p_unit_cost_micros, p_daily_limit, p_per_minute, p_source_duration_ms, false)
$$;
