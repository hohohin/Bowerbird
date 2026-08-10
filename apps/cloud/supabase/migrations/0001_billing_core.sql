-- Bowerbird Cloud billing facts.
-- Media, prompts and local-library data never belong in these tables.

create extension if not exists pgcrypto with schema extensions;

-- Billing facts outlive an Auth identity for financial audit. `id` initially equals auth.users.id so
-- own-row RLS stays cheap; deleting Auth only detaches the identity and never cascades the ledger.
create table public.billing_accounts (
  id uuid primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  detached_at timestamptz
);

create or replace function public.mark_billing_account_detached()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.detached_at := now();
  return new;
end;
$$;

create table public.subscriptions (
  user_id uuid primary key references public.billing_accounts(id) on delete restrict,
  tier text not null default 'free' check (tier in ('free', 'pro', 'studio')),
  period text check (period is null or period in ('monthly', 'yearly')),
  status text not null default 'active' check (status in ('active', 'canceled', 'past_due', 'expired')),
  provider text check (provider is null or provider in ('mock', 'superun', 'paddle')),
  provider_subscription_id text,
  entitlement_version integer not null default 1 check (entitlement_version > 0),
  current_period_start timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create table public.orders (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  provider text not null check (provider in ('mock', 'superun', 'paddle')),
  provider_order_id text not null,
  provider_event_id text,
  product text not null,
  amount_minor integer not null check (amount_minor >= 0),
  currency text not null check (char_length(currency) = 3),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_order_id)
);

create unique index orders_provider_event_unique_idx
  on public.orders (provider, provider_event_id)
  where provider_event_id is not null;
create index orders_user_created_idx on public.orders (user_id, created_at desc);

create table public.service_costs (
  service text primary key,
  unit_cost integer not null check (unit_cost >= 0),
  pricing_version integer not null default 1 check (pricing_version > 0),
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.service_costs (service, unit_cost, parameters) values
  ('caption', 1, '{}'),
  ('image_sd', 5, '{}'),
  ('image_hd', 10, '{}'),
  ('video_sd2_5s', 100, '{"duration_seconds":5,"resolution":"sd2"}'),
  ('video_sd2_15s', 280, '{"duration_seconds":15,"resolution":"sd2"}'),
  ('video_sd25_5s', 160, '{"duration_seconds":5,"resolution":"sd25"}'),
  ('video_sd25_15s', 450, '{"duration_seconds":15,"resolution":"sd25"}'),
  ('video_sd25_30s', 900, '{"duration_seconds":30,"resolution":"sd25"}');

create table public.credit_lots (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  bucket text not null check (bucket in ('daily', 'sub', 'topup')),
  source_key text not null,
  original_amount integer not null check (original_amount > 0),
  remaining_amount integer not null check (remaining_amount >= 0 and remaining_amount <= original_amount),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, source_key),
  unique (id, user_id)
);

create index credit_lots_fifo_idx
  on public.credit_lots (user_id, expires_at, created_at, id)
  where remaining_amount > 0;

create table public.credit_holds (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  idempotency_key text not null,
  service text not null references public.service_costs(service),
  pricing_version integer not null check (pricing_version > 0),
  estimated_amount integer not null check (estimated_amount > 0),
  actual_amount integer check (actual_amount is null or actual_amount >= 0),
  status text not null default 'held'
    check (status in ('held', 'confirmed', 'rolled_back', 'pending_settlement', 'expired')),
  reason text,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (id, user_id),
  check ((status = 'confirmed' and actual_amount is not null) or status <> 'confirmed')
);

create index credit_holds_user_created_idx on public.credit_holds (user_id, created_at desc);
create index credit_holds_stale_idx on public.credit_holds (expires_at) where status = 'held';

create table public.credit_hold_allocations (
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  hold_id uuid not null,
  lot_id uuid not null,
  amount integer not null check (amount > 0),
  primary key (hold_id, lot_id),
  foreign key (hold_id, user_id) references public.credit_holds(id, user_id) on delete cascade,
  foreign key (lot_id, user_id) references public.credit_lots(id, user_id) on delete restrict
);

create index credit_hold_allocations_lot_idx on public.credit_hold_allocations (lot_id);

create table public.credit_transactions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  hold_id uuid,
  lot_id uuid,
  kind text not null check (kind in ('grant', 'hold', 'confirm', 'rollback', 'expire', 'refund', 'adjust')),
  amount integer not null,
  service text references public.service_costs(service),
  meta jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (hold_id, user_id) references public.credit_holds(id, user_id) on delete restrict,
  foreign key (lot_id, user_id) references public.credit_lots(id, user_id) on delete restrict
);

create index credit_transactions_user_created_idx
  on public.credit_transactions (user_id, created_at desc, id desc);
create index credit_transactions_hold_idx on public.credit_transactions (hold_id) where hold_id is not null;

create table public.user_credits (
  user_id uuid primary key references public.billing_accounts(id) on delete restrict,
  daily_balance integer not null default 0 check (daily_balance >= 0),
  sub_balance integer not null default 0 check (sub_balance >= 0),
  topup_balance integer not null default 0 check (topup_balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.usage_daily (
  user_id uuid not null references public.billing_accounts(id) on delete restrict,
  business_date date not null,
  understand_count integer not null default 0 check (understand_count >= 0),
  request_count integer not null default 0 check (request_count >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  primary key (user_id, business_date)
);

create table public.system_usage_daily (
  business_date date primary key,
  request_count bigint not null default 0 check (request_count >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  updated_at timestamptz not null default now()
);

-- The ledger is append-only. Corrections are represented by compensating transactions.
create or replace function public.reject_credit_transaction_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'credit_transactions is append-only' using errcode = '55000';
end;
$$;

create trigger credit_transactions_no_update
before update on public.credit_transactions
for each row execute function public.reject_credit_transaction_mutation();

create trigger credit_transactions_no_delete
before delete on public.credit_transactions
for each row execute function public.reject_credit_transaction_mutation();

create trigger credit_transactions_no_truncate
before truncate on public.credit_transactions
for each statement execute function public.reject_credit_transaction_mutation();

-- A registration-day grant is the user's daily free allowance, not an additional trial bucket.
-- Reusing daily:<Asia/Shanghai date> makes trigger/RPC/cron retries idempotent.
create or replace function public.initialize_bowerbird_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  business_date date := timezone('Asia/Shanghai', now())::date;
  daily_source text := 'daily:' || business_date::text;
  daily_expiry timestamptz := ((business_date + 1)::timestamp at time zone 'Asia/Shanghai');
  lot_id uuid;
begin
  insert into public.billing_accounts (id, auth_user_id)
  values (new.id, new.id)
  on conflict (id) do update set auth_user_id = excluded.auth_user_id, detached_at = null;

  insert into public.subscriptions (user_id, tier, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  insert into public.user_credits (user_id, daily_balance, sub_balance, topup_balance)
  values (new.id, 0, 0, 0)
  on conflict (user_id) do nothing;

  insert into public.credit_lots (
    user_id, bucket, source_key, original_amount, remaining_amount, expires_at
  ) values (
    new.id, 'daily', daily_source, 30, 30, daily_expiry
  )
  on conflict (user_id, source_key) do nothing
  returning id into lot_id;

  if lot_id is not null then
    update public.user_credits
      set daily_balance = daily_balance + 30,
          updated_at = now()
      where user_id = new.id;

    insert into public.credit_transactions (user_id, lot_id, kind, amount, meta)
    values (
      new.id,
      lot_id,
      'grant',
      30,
      jsonb_build_object('source', 'daily', 'business_date', business_date)
    );
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created_initialize_bowerbird
  after insert on auth.users
  for each row execute function public.initialize_bowerbird_user();

create trigger on_auth_user_deleted_detach_billing
  before update of auth_user_id on public.billing_accounts
  for each row
  when (old.auth_user_id is not null and new.auth_user_id is null)
  execute function public.mark_billing_account_detached();

comment on table public.billing_accounts is 'Stable billing identity; Auth deletion detaches rather than deleting financial facts.';
comment on table public.credit_lots is 'Credit grant lots; the auditable source for expiry and FIFO deduction.';
comment on table public.credit_holds is 'Idempotent pre-authorizations for managed compute usage.';
comment on table public.user_credits is 'RPC-maintained read snapshot; not the billing audit source.';
comment on column public.credit_transactions.meta is 'Non-sensitive billing metadata only; never store prompts, images, tokens, or keys.';
