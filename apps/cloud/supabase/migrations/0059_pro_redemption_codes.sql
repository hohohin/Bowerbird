-- One-use Pro monthly vouchers. Only trusted services can issue or redeem codes.
-- Store SHA-256 digests only; plaintext codes never belong in the database or logs.
create table public.pro_redemption_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.pro_code_redemptions (
  code_id uuid primary key references public.pro_redemption_codes(id) on delete restrict,
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  redeemed_at timestamptz not null default now(),
  period_end timestamptz not null,
  credits integer not null check (credits = 1100),
  credits_expires_at timestamptz not null
);

create table public.pro_redemption_attempts (
  user_id uuid primary key references public.billing_accounts(id) on delete restrict,
  window_start timestamptz not null,
  attempts integer not null check (attempts > 0)
);

alter table public.pro_redemption_codes enable row level security;
alter table public.pro_redemption_codes force row level security;
alter table public.pro_code_redemptions enable row level security;
alter table public.pro_code_redemptions force row level security;
alter table public.pro_redemption_attempts enable row level security;
alter table public.pro_redemption_attempts force row level security;
revoke all on public.pro_redemption_codes, public.pro_code_redemptions, public.pro_redemption_attempts from public, anon, authenticated;
grant all on public.pro_redemption_codes, public.pro_code_redemptions, public.pro_redemption_attempts to service_role;

alter table public.subscriptions drop constraint subscriptions_provider_check;
alter table public.subscriptions add constraint subscriptions_provider_check
  check (provider is null or provider in ('mock', 'superun', 'paddle', 'redemption'));

create function public.redeem_pro_code(p_user_id uuid, p_code_hash text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_attempts integer;
  v_code public.pro_redemption_codes;
  v_receipt public.pro_code_redemptions;
  v_subscription public.subscriptions;
  v_active boolean;
  v_end timestamptz;
begin
  if not exists (select 1 from public.billing_accounts where id = p_user_id and auth_user_id = p_user_id) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Return business failures instead of raising: the attempt counter must commit on invalid codes.
  insert into public.pro_redemption_attempts as attempts (user_id, window_start, attempts)
  values (p_user_id, v_now, 1)
  on conflict (user_id) do update set
    attempts = case when attempts.window_start <= v_now - interval '15 minutes' then 1
      else least(attempts.attempts + 1, 11) end,
    window_start = case when attempts.window_start <= v_now - interval '15 minutes' then v_now
      else attempts.window_start end
  returning attempts into v_attempts;
  if v_attempts > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  select * into v_code from public.pro_redemption_codes where code_hash = p_code_hash for update;
  if not found then return jsonb_build_object('status', 'invalid_code'); end if;

  select * into v_receipt from public.pro_code_redemptions where code_id = v_code.id;
  if found then
    if v_receipt.user_id <> p_user_id then
      return jsonb_build_object('status', 'invalid_code');
    end if;
    -- A lost HTTP response can be retried, even after the voucher expires or is disabled.
    return jsonb_build_object('status', 'redeemed', 'already_redeemed', true,
      'period_end', v_receipt.period_end, 'credits', v_receipt.credits,
      'credits_expires_at', v_receipt.credits_expires_at);
  end if;
  if v_code.disabled_at is not null or v_code.expires_at <= v_now then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  -- Follow the credit-grant lock order, serializing different vouchers for the same account too.
  perform 1 from public.user_credits where user_id = p_user_id for update;
  select * into strict v_subscription from public.subscriptions where user_id = p_user_id for update;
  v_active := v_subscription.status = 'active' and
    (v_subscription.current_period_end is null or v_subscription.current_period_end > v_now);
  if v_active and v_subscription.tier = 'studio' then
    return jsonb_build_object('status', 'studio_active');
  end if;
  if v_active and v_subscription.tier = 'pro' and v_subscription.current_period_end is null then
    return jsonb_build_object('status', 'permanent_pro');
  end if;
  v_end := ((case when v_active and v_subscription.tier = 'pro'
    then v_subscription.current_period_end else v_now end) at time zone 'Asia/Shanghai'
    + interval '1 month') at time zone 'Asia/Shanghai';

  update public.subscriptions set tier = 'pro', status = 'active',
    period = case when v_active and v_subscription.tier = 'pro' then v_subscription.period else 'monthly' end,
    provider = case when v_active and v_subscription.tier = 'pro' then v_subscription.provider else 'redemption' end,
    provider_subscription_id = case when v_active and v_subscription.tier = 'pro' then v_subscription.provider_subscription_id else null end,
    current_period_start = case when v_active and v_subscription.tier = 'pro' then v_subscription.current_period_start else v_now end,
    current_period_end = v_end, entitlement_version = entitlement_version + 1, updated_at = v_now
  where user_id = p_user_id;

  perform public.grant_subscription_credits(p_user_id, 'redemption:' || v_code.id::text, 1100, v_now + interval '30 days');
  insert into public.pro_code_redemptions(code_id, user_id, period_end, credits, credits_expires_at)
    values (v_code.id, p_user_id, v_end, 1100, v_now + interval '30 days');
  return jsonb_build_object('status', 'redeemed', 'already_redeemed', false,
    'period_end', v_end, 'credits', 1100, 'credits_expires_at', v_now + interval '30 days');
end;
$$;

revoke all on function public.redeem_pro_code(uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_pro_code(uuid, text) to service_role;
