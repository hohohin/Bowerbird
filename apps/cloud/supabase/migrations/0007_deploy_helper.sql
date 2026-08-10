-- Idempotent schema deployment for Supabase Edge Runtime + Auth hooks.
-- Requires a linked project: supabase link --project-ref <ref>

begin;

-- Billing tables (same shape as migrations, created if missing)
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'pro', 'studio')),
  period text check (period is null or period in ('monthly', 'yearly')),
  status text not null default 'active' check (status in ('active', 'canceled', 'past_due', 'expired')),
  provider text check (provider is null or provider in ('mock', 'superun', 'paddle')),
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create table if not exists public.orders (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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

create unique index if not exists orders_provider_event_unique_idx
  on public.orders (provider, provider_event_id)
  where provider_event_id is not null;

create table if not exists public.service_costs (
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
  ('video_sd25_30s', 900, '{"duration_seconds":30,"resolution":"sd25"}')
on conflict (service) do nothing;

create table if not exists public.credit_lots (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null check (bucket in ('daily', 'sub', 'topup')),
  source_key text not null,
  original_amount integer not null check (original_amount > 0),
  remaining_amount integer not null check (remaining_amount >= 0 and remaining_amount <= original_amount),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, source_key)
);

create index if not exists credit_lots_fifo_idx
  on public.credit_lots (user_id, expires_at, created_at, id)
  where remaining_amount > 0;

create table if not exists public.credit_holds (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  service text not null references public.service_costs(service),
  estimated_amount integer not null check (estimated_amount > 0),
  actual_amount integer check (actual_amount is null or actual_amount >= 0),
  status text not null default 'held'
    check (status in ('held', 'confirmed', 'rolled_back', 'pending_settlement', 'expired')),
  reason text,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check ((status = 'confirmed' and actual_amount is not null) or status <> 'confirmed')
);

create index if not exists credit_holds_user_created_idx on public.credit_holds (user_id, created_at desc);
create index if not exists credit_holds_stale_idx on public.credit_holds (expires_at) where status = 'held';

create table if not exists public.credit_hold_allocations (
  hold_id uuid not null references public.credit_holds(id) on delete cascade,
  lot_id uuid not null references public.credit_lots(id) on delete restrict,
  amount integer not null check (amount > 0),
  primary key (hold_id, lot_id)
);

create table if not exists public.credit_transactions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  hold_id uuid references public.credit_holds(id) on delete restrict,
  lot_id uuid references public.credit_lots(id) on delete restrict,
  kind text not null check (kind in ('grant', 'hold', 'confirm', 'rollback', 'expire', 'refund', 'adjust')),
  amount integer not null,
  service text references public.service_costs(service),
  meta jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions (user_id, created_at desc, id desc);

create table if not exists public.user_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_balance integer not null default 0 check (daily_balance >= 0),
  sub_balance integer not null default 0 check (sub_balance >= 0),
  topup_balance integer not null default 0 check (topup_balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  business_date date not null,
  understand_count integer not null default 0 check (understand_count >= 0),
  request_count integer not null default 0 check (request_count >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  primary key (user_id, business_date)
);

create table if not exists public.system_usage_daily (
  business_date date primary key,
  request_count bigint not null default 0 check (request_count >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

commit;

-- Functions (recreated to keep idempotency; full RPC definitions follow)
create or replace function public.reject_credit_transaction_mutation() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'credit_transactions is append-only' using errcode = '55000';
end;
$$;

drop trigger if exists credit_transactions_no_update on public.credit_transactions;
create trigger credit_transactions_no_update
before update on public.credit_transactions
for each row execute function public.reject_credit_transaction_mutation();

drop trigger if exists credit_transactions_no_delete on public.credit_transactions;
create trigger credit_transactions_no_delete
before delete on public.credit_transactions
for each row execute function public.reject_credit_transaction_mutation();

create or replace function public.initialize_bowerbird_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  business_date date := timezone('Asia/Shanghai', now())::date;
  daily_source text := 'daily:' || business_date::text;
  daily_expiry timestamptz := ((business_date + 1)::timestamp at time zone 'Asia/Shanghai');
  lot_id uuid;
begin
  insert into public.billing_accounts (id, auth_user_id)
  values (new.id, new.id)
  on conflict (id) do update
    set auth_user_id = excluded.auth_user_id,
        detached_at = null;

  insert into public.subscriptions (user_id, tier, status) values (new.id, 'free', 'active') on conflict (user_id) do nothing;
  insert into public.user_credits (user_id, daily_balance, sub_balance, topup_balance) values (new.id, 0, 0, 0) on conflict (user_id) do nothing;
  insert into public.credit_lots (user_id, bucket, source_key, original_amount, remaining_amount, expires_at) values (new.id, 'daily', daily_source, 30, 30, daily_expiry) on conflict (user_id, source_key) do nothing returning id into lot_id;
  if lot_id is not null then
    update public.user_credits set daily_balance = daily_balance + 30, updated_at = now() where user_id = new.id;
    insert into public.credit_transactions (user_id, lot_id, kind, amount, meta) values (new.id, lot_id, 'grant', 30, jsonb_build_object('source', 'daily', 'business_date', business_date));
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_initialize_bowerbird on auth.users;
create trigger on_auth_user_created_initialize_bowerbird
  after insert on auth.users for each row execute function public.initialize_bowerbird_user();

-- RLS + grants (concise; full policies in migration 0002 are the authoritative source)
alter table public.subscriptions enable row level security;
alter table public.orders enable row level security;
alter table public.service_costs enable row level security;
alter table public.credit_lots enable row level security;
alter table public.credit_holds enable row level security;
alter table public.credit_hold_allocations enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.user_credits enable row level security;
alter table public.usage_daily enable row level security;
alter table public.system_usage_daily enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.billing_accounts to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.orders to authenticated;
grant select on public.service_costs to anon, authenticated;
grant select on public.credit_lots to authenticated;
grant select on public.credit_holds to authenticated;
grant select on public.credit_hold_allocations to authenticated;
grant select on public.credit_transactions to authenticated;
grant select on public.user_credits to authenticated;

revoke execute on function public.reject_credit_transaction_mutation() from public, anon, authenticated;
revoke execute on function public.initialize_bowerbird_user() from public, anon, authenticated;
grant execute on function public.initialize_bowerbird_user() to supabase_auth_admin;

-- Compact own-row policies (mirror 0002_billing_rls)
drop policy if exists billing_accounts_select_own on public.billing_accounts;
create policy billing_accounts_select_own on public.billing_accounts for select to authenticated using ((select auth.uid()) = auth_user_id);
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = subscriptions.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = orders.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists credit_lots_select_own on public.credit_lots;
create policy credit_lots_select_own on public.credit_lots for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = credit_lots.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists credit_holds_select_own on public.credit_holds;
create policy credit_holds_select_own on public.credit_holds for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = credit_holds.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists credit_hold_allocations_select_own on public.credit_hold_allocations;
create policy credit_hold_allocations_select_own on public.credit_hold_allocations for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = credit_hold_allocations.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists credit_transactions_select_own on public.credit_transactions;
create policy credit_transactions_select_own on public.credit_transactions for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = credit_transactions.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists user_credits_select_own on public.user_credits;
create policy user_credits_select_own on public.user_credits for select to authenticated using (exists (select 1 from public.billing_accounts as account where account.id = user_credits.user_id and account.auth_user_id = (select auth.uid())));
drop policy if exists service_costs_select_active on public.service_costs;
create policy service_costs_select_active on public.service_costs for select to anon, authenticated using (active);
