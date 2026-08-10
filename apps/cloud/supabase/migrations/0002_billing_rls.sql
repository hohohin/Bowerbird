-- Billing tables are client-readable only for the owning user.
-- All writes go through service-side Edge Functions / security-definer RPCs.

alter table public.billing_accounts enable row level security;
alter table public.billing_accounts force row level security;
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;
alter table public.orders enable row level security;
alter table public.orders force row level security;
alter table public.service_costs enable row level security;
alter table public.service_costs force row level security;
alter table public.credit_lots enable row level security;
alter table public.credit_lots force row level security;
alter table public.credit_holds enable row level security;
alter table public.credit_holds force row level security;
alter table public.credit_hold_allocations enable row level security;
alter table public.credit_hold_allocations force row level security;
alter table public.credit_transactions enable row level security;
alter table public.credit_transactions force row level security;
alter table public.user_credits enable row level security;
alter table public.user_credits force row level security;
alter table public.usage_daily enable row level security;
alter table public.usage_daily force row level security;
alter table public.system_usage_daily enable row level security;
alter table public.system_usage_daily force row level security;

-- Keep schema discovery available while removing every direct table privilege first.
revoke all on table public.billing_accounts from anon, authenticated;
revoke all on table public.subscriptions from anon, authenticated;
revoke all on table public.orders from anon, authenticated;
revoke all on table public.service_costs from anon, authenticated;
revoke all on table public.credit_lots from anon, authenticated;
revoke all on table public.credit_holds from anon, authenticated;
revoke all on table public.credit_hold_allocations from anon, authenticated;
revoke all on table public.credit_transactions from anon, authenticated;
revoke all on table public.user_credits from anon, authenticated;
revoke all on table public.usage_daily from anon, authenticated;
revoke all on table public.system_usage_daily from anon, authenticated;

-- Authenticated clients may only read their own account state.
grant select on table public.billing_accounts to authenticated;
grant select on table public.subscriptions to authenticated;
grant select on table public.orders to authenticated;
grant select on table public.credit_lots to authenticated;
grant select on table public.credit_holds to authenticated;
grant select on table public.credit_hold_allocations to authenticated;
grant select on table public.credit_transactions to authenticated;
grant select on table public.user_credits to authenticated;

-- Active prices are public product configuration; mutation remains service-only.
grant select on table public.service_costs to anon, authenticated;

create policy billing_accounts_select_own
on public.billing_accounts for select
to authenticated
using ((select auth.uid()) = auth_user_id);

create policy subscriptions_select_own
on public.subscriptions for select
to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = subscriptions.user_id
      and account.auth_user_id = (select auth.uid())
  )
);

create policy orders_select_own
on public.orders for select
to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = orders.user_id and account.auth_user_id = (select auth.uid())
  )
);

create policy credit_lots_select_own
on public.credit_lots for select
to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = credit_lots.user_id and account.auth_user_id = (select auth.uid())
  )
);

create policy credit_holds_select_own
on public.credit_holds for select
to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = credit_holds.user_id and account.auth_user_id = (select auth.uid())
  )
);

-- Allocation ownership is derived from the hold. This policy is read-only and cannot create
-- cross-user allocations because clients have no write privilege/policy.
create policy credit_hold_allocations_select_own
on public.credit_hold_allocations for select
to authenticated
using (
  exists (
    select 1
    from public.billing_accounts as account
    where account.id = credit_hold_allocations.user_id
      and account.auth_user_id = (select auth.uid())
  )
);

create policy credit_transactions_select_own
on public.credit_transactions for select
to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = credit_transactions.user_id and account.auth_user_id = (select auth.uid())
  )
);

create policy user_credits_select_own
on public.user_credits for select
to authenticated
using (
  exists (
    select 1 from public.billing_accounts as account
    where account.id = user_credits.user_id and account.auth_user_id = (select auth.uid())
  )
);

create policy service_costs_select_active
on public.service_costs for select
to anon, authenticated
using (active);

-- usage_daily and system_usage_daily deliberately have no client SELECT policy. Entitlement and
-- rate-limit Functions expose only the minimal derived values needed by the UI.

-- Trigger helpers are never client-callable.
revoke execute on function public.reject_credit_transaction_mutation() from public, anon, authenticated;
revoke execute on function public.initialize_bowerbird_user() from public, anon, authenticated;
revoke execute on function public.mark_billing_account_detached() from public, anon, authenticated;

grant execute on function public.initialize_bowerbird_user() to supabase_auth_admin;

comment on policy credit_hold_allocations_select_own on public.credit_hold_allocations is
  'Read-only ownership is inherited from the parent hold; no client write privileges exist.';
