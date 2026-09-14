-- Layer editing is a distinct, currently disabled service. Prices are intentionally unset.
-- Unit cost is per operation (whole decomposition / one layer edit), not per returned image.
insert into public.service_costs(service, unit_cost, active, parameters) values
 ('image_layer_decompose', 0, false, '{"pricing_ready":false,"operation":"decompose","max_outputs":17}'),
 ('image_layer_edit', 0, false, '{"pricing_ready":false,"operation":"edit","max_outputs":1}')
on conflict(service) do nothing;
alter table public.service_costs add constraint layer_pricing_activation_check check (
 service not in ('image_layer_decompose','image_layer_edit') or not active
 or (unit_cost > 0 and parameters @> '{"pricing_ready":true}'::jsonb)
);
alter table public.generation_jobs drop constraint generation_jobs_output_mime_check;
alter table public.generation_jobs add constraint generation_jobs_output_mime_check check (
 output_mime is null or output_mime in ('image/png','image/jpeg','image/webp','video/mp4','application/json')
);
alter table public.generation_jobs add constraint layer_output_service_check check (
 output_mime is null or ((service in ('image_layer_decompose','image_layer_edit')) = (output_mime = 'application/json'))
);
create or replace function public.complete_generation_job(
  p_job_id uuid,
  p_lease_id uuid,
  p_status text,
  p_output_object_key text default null,
  p_output_mime text default null,
  p_output_bytes bigint default null,
  p_output_sha256 text default null,
  p_error_code text default null,
  p_safe_message text default null
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.generation_jobs;
  result public.generation_jobs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    raise exception 'invalid terminal generation status' using errcode = '22023';
  end if;
  if p_output_sha256 is not null and p_output_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid output hash' using errcode = '22023';
  end if;
  if p_status = 'succeeded' and (
      p_output_object_key is null or p_output_mime is null or p_output_mime not in ('image/png', 'image/jpeg', 'image/webp', 'application/json')
      or p_output_bytes is null or p_output_bytes <= 0 or p_output_sha256 is null
  ) then
    raise exception 'successful generation requires output metadata' using errcode = '22023';
  end if;

  select job.* into locked
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;
  if not found then
    raise exception 'unknown generation job' using errcode = 'P0002';
  end if;
  if p_status = 'succeeded' and ((locked.service in ('image_layer_decompose','image_layer_edit')) is distinct from (p_output_mime = 'application/json')) then
    raise exception 'layer output/service mismatch' using errcode = '22023';
  end if;
  if locked.status in ('succeeded', 'failed', 'cancelled', 'outcome_unknown') then
    if locked.status <> p_status then
      raise exception 'generation job already completed as %', locked.status using errcode = '55000';
    end if;
    return locked;
  end if;
  if locked.lease_id is distinct from p_lease_id
      or locked.lease_expires_at is null
      or locked.lease_expires_at <= now()
      or locked.status not in ('leased', 'running', 'cancel_requested') then
    raise exception 'invalid generation lease or status' using errcode = '55000';
  end if;

  if p_status = 'succeeded' then
    perform public.credit_confirm(locked.hold_id, locked.estimated_credits);
  elsif p_status in ('failed', 'cancelled') then
    perform public.credit_rollback(locked.hold_id, coalesce(p_error_code, p_status));
  else
    perform public.mark_hold_pending_settlement(locked.hold_id, coalesce(p_error_code, 'outcome_unknown'));
  end if;

  update public.generation_jobs as job
  set status = p_status,
      progress = case when p_status = 'succeeded' then 100 else job.progress end,
      actual_credits = case when p_status = 'succeeded' then job.estimated_credits else null end,
      output_object_key = case when p_status = 'succeeded' then p_output_object_key else null end,
      output_mime = case when p_status = 'succeeded' then p_output_mime else null end,
      output_bytes = case when p_status = 'succeeded' then p_output_bytes else null end,
      output_sha256 = case when p_status = 'succeeded' then p_output_sha256 else null end,
      error_code = left(p_error_code, 80),
      safe_message = left(p_safe_message, 500),
      finished_at = now(),
      lease_id = null,
      lease_owner = null,
      lease_expires_at = null
  where job.id = p_job_id
  returning job.* into result;
  return result;
end;
$$;
