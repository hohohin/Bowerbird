-- A user explicitly starts a one-time feature trial. No Bcoin, payment or renewal.
alter table public.subscriptions add column trial_started_at timestamptz;
create function public.start_pro_feature_trial(p_user_id uuid) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare s public.subscriptions; ends timestamptz;
begin
 perform 1 from public.user_credits where user_id=p_user_id for update;
 select * into strict s from public.subscriptions where user_id=p_user_id for update;
 if s.trial_started_at is not null then return s.trial_started_at+interval '7 days'; end if;
 if s.tier in ('pro','studio') then raise exception 'feature trial is for first-time free accounts'; end if;
 ends:=now()+interval '7 days';
 update public.subscriptions set tier='pro',status='active',period='monthly',provider=null,
  trial_started_at=now(),current_period_start=now(),current_period_end=ends,
  entitlement_version=entitlement_version+1,updated_at=now() where user_id=p_user_id;
 return ends;
end $$;
revoke all on function public.start_pro_feature_trial(uuid) from public,anon,authenticated;
grant execute on function public.start_pro_feature_trial(uuid) to service_role;
