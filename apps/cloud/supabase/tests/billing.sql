-- Billing integration assertions.
-- Run after `supabase db reset` as a database owner/service test role.
-- This script uses a transaction and rolls everything back.

begin;

create temporary table billing_test_results (
  name text primary key,
  ok boolean not null
);

do $$
declare
  user_a uuid := extensions.gen_random_uuid();
  user_b uuid := extensions.gen_random_uuid();
  first_lot uuid;
  second_lot uuid;
  hold uuid;
  replay_hold uuid;
  balance public.user_credits;
  grant_count integer;
  tx_count integer;
  rejected boolean;
begin
  -- Create auth users: the production trigger must initialize exactly one daily lot worth 30.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values
    (user_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'billing-a@example.test', '', now(), now(), now()),
    (user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'billing-b@example.test', '', now(), now(), now());

  select count(*) into grant_count
  from public.credit_lots
  where user_id = user_a and source_key like 'daily:%' and original_amount = 30;
  insert into billing_test_results values ('registration creates one daily 30 lot', grant_count = 1);

  perform * from public.grant_daily_credits(user_a, timezone('Asia/Shanghai', now())::date, 30);
  select count(*) into grant_count from public.credit_lots where user_id = user_a and source_key like 'daily:%';
  insert into billing_test_results values ('daily grant replay is idempotent', grant_count = 1);

  -- Add two deterministic lots and consume daily before sub before topup.
  update public.credit_lots set remaining_amount = 0 where user_id = user_a;
  insert into public.credit_lots (user_id, bucket, source_key, original_amount, remaining_amount, expires_at)
  values (user_a, 'daily', 'test:daily', 2, 2, now() + interval '1 day') returning id into first_lot;
  insert into public.credit_lots (user_id, bucket, source_key, original_amount, remaining_amount, expires_at)
  values (user_a, 'sub', 'test:sub', 10, 10, now() + interval '30 days') returning id into second_lot;
  perform public.refresh_user_credit_snapshot(user_a);

  select result.hold_id into hold
  from public.credit_hold(user_a, 'test-hold', 'image_sd', 5) as result;
  select result.hold_id into replay_hold
  from public.credit_hold(user_a, 'test-hold', 'image_sd', 5) as result;
  insert into billing_test_results values ('hold replay returns same id', hold = replay_hold);
  insert into billing_test_results values (
    'FIFO consumes daily first',
    exists (select 1 from public.credit_lots where id = first_lot and remaining_amount = 0)
  );
  insert into billing_test_results values (
    'FIFO continues into subscription',
    exists (select 1 from public.credit_lots where id = second_lot and remaining_amount = 7)
  );

  perform * from public.credit_confirm(hold, 3);
  select count(*) into tx_count from public.credit_holds where id = hold and status = 'confirmed' and actual_amount = 3;
  insert into billing_test_results values ('confirm supports estimate refund', tx_count = 1 and exists (
    select 1 from public.credit_hold_allocations where hold_id = hold
    group by hold_id having sum(amount) = 3
  ));
  select count(*) into tx_count from public.credit_transactions where hold_id = hold;
  perform * from public.credit_confirm(hold, 3);
  insert into billing_test_results values (
    'confirm replay is idempotent',
    tx_count = (select count(*) from public.credit_transactions where hold_id = hold)
  );

  -- A confirmed hold may not roll back.
  rejected := false;
  begin
    perform * from public.credit_rollback(hold, 'must-fail');
  exception when sqlstate '55000' then
    rejected := true;
  end;
  insert into billing_test_results values ('confirmed hold rejects rollback', rejected);

  -- Insufficient balance must reject before creating a hold.
  update public.credit_lots set remaining_amount = 0 where user_id = user_b;
  perform public.refresh_user_credit_snapshot(user_b);
  rejected := false;
  begin
    perform * from public.credit_hold(user_b, 'no-money', 'image_sd', 5);
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  insert into billing_test_results values ('insufficient credits rejects hold', rejected);

  -- Append-only ledger protection.
  rejected := false;
  begin
    update public.credit_transactions set amount = amount where user_id = user_a;
  exception when sqlstate '55000' then
    rejected := true;
  end;
  insert into billing_test_results values ('transactions are append-only', rejected);

  -- Privilege checks: authenticated has SELECT but no writes or service RPC execution.
  insert into billing_test_results
  select 'authenticated cannot insert credit lots', not has_table_privilege('authenticated', 'public.credit_lots', 'INSERT');
  insert into billing_test_results
  select 'authenticated cannot execute credit_hold', not has_function_privilege(
    'authenticated', 'public.credit_hold(uuid,text,text,integer)', 'EXECUTE'
  );
end;
$$;

-- Every assertion must be true.
do $$
declare failed text;
begin
  select string_agg(name, ', ' order by name) into failed
  from billing_test_results where not ok;
  if failed is not null then
    raise exception 'billing tests failed: %', failed;
  end if;
end;
$$;

select name, ok from billing_test_results order by name;
rollback;
