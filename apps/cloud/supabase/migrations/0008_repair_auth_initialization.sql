-- Repair the deploy helper's registration function and restore the billing-account RLS mapping.

begin;

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
  on conflict (id) do update
    set auth_user_id = excluded.auth_user_id,
        detached_at = null;

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

drop trigger if exists on_auth_user_created_initialize_bowerbird on auth.users;
create trigger on_auth_user_created_initialize_bowerbird
  after insert on auth.users
  for each row execute function public.initialize_bowerbird_user();

revoke execute on function public.initialize_bowerbird_user() from public, anon, authenticated;
grant execute on function public.initialize_bowerbird_user() to supabase_auth_admin;

grant select on public.billing_accounts to authenticated;

drop policy if exists billing_accounts_select_own on public.billing_accounts;
create policy billing_accounts_select_own
on public.billing_accounts for select
to authenticated
using ((select auth.uid()) = auth_user_id);

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own
on public.subscriptions for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = subscriptions.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists orders_select_own on public.orders;
create policy orders_select_own
on public.orders for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = orders.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists credit_lots_select_own on public.credit_lots;
create policy credit_lots_select_own
on public.credit_lots for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = credit_lots.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists credit_holds_select_own on public.credit_holds;
create policy credit_holds_select_own
on public.credit_holds for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = credit_holds.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists credit_hold_allocations_select_own on public.credit_hold_allocations;
create policy credit_hold_allocations_select_own
on public.credit_hold_allocations for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = credit_hold_allocations.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists credit_transactions_select_own on public.credit_transactions;
create policy credit_transactions_select_own
on public.credit_transactions for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = credit_transactions.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists user_credits_select_own on public.user_credits;
create policy user_credits_select_own
on public.user_credits for select
to authenticated
using (exists (
  select 1 from public.billing_accounts as account
  where account.id = user_credits.user_id
    and account.auth_user_id = (select auth.uid())
));

drop policy if exists service_costs_select_active on public.service_costs;
create policy service_costs_select_active
on public.service_costs for select
to anon, authenticated
using (active);

commit;
