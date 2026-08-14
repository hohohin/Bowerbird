-- Agent Runtime A1-T1 integration assertions.
-- Run after `supabase db reset`; the transaction rolls back all fixture rows.

begin;

create temporary table agent_runtime_test_results (
  name text primary key,
  ok boolean not null
);

do $$
declare
  test_user uuid := extensions.gen_random_uuid();
  hold uuid;
  run_id uuid;
  first_claim public.agent_runs;
  second_claim public.agent_runs;
  transitioned public.agent_runs;
  rejected boolean;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values (
    test_user, '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'agent-runtime@example.test', '', now(), now(), now()
  );

  select result.hold_id into hold
  from public.credit_hold(test_user, 'agent-runtime-hold', 'agent_smart_refinement', 15) as result;

  insert into public.agent_runs (
    user_id, skill_id, skill_version, kernel_version, status,
    input_count, input_manifest_hash, request_object_key,
    budget_credits, hold_id, pricing_version, queued_at, content_expires_at
  ) values (
    test_user, 'smart-refinement', '1.0.0', '0.1.0', 'queued',
    1, repeat('a', 64), 'runs/test/request.json',
    15, hold, 1, now(), now() + interval '24 hours'
  ) returning id into run_id;

  first_claim := public.claim_agent_run('worker-a', 60);
  second_claim := public.claim_agent_run('worker-b', 60);
  insert into agent_runtime_test_results values (
    'double claim returns only one run',
    first_claim.id = run_id and second_claim.id is null
  );

  rejected := false;
  begin
    perform * from public.heartbeat_agent_run(run_id, extensions.gen_random_uuid(), 60);
  exception when sqlstate '55000' then
    rejected := true;
  end;
  insert into agent_runtime_test_results values ('wrong lease heartbeat rejects', rejected);

  transitioned := public.transition_agent_run(
    run_id, first_claim.lease_id, 'running', 'parse_intent', 10
  );
  insert into agent_runtime_test_results values (
    'leased run transitions to running and keeps lease',
    transitioned.status = 'running' and transitioned.lease_id = first_claim.lease_id
  );

  rejected := false;
  begin
    perform public.transition_agent_run(
      run_id, first_claim.lease_id, 'succeeded', 'done', 100
    );
  exception when sqlstate '55000' then
    rejected := true;
  end;
  insert into agent_runtime_test_results values ('illegal running to succeeded jump rejects', rejected);

  transitioned := public.transition_agent_run(
    run_id, first_claim.lease_id, 'awaiting_approval',
    'await_plan_approval', 45, 'runs/test/checkpoint.json', repeat('b', 64), 1
  );
  insert into agent_runtime_test_results values (
    'approval pause releases lease',
    transitioned.status = 'awaiting_approval'
      and transitioned.lease_id is null
      and transitioned.checkpoint_hash = repeat('b', 64)
  );

  insert into agent_runtime_test_results
  select 'authenticated can select agent runs',
    has_table_privilege('authenticated', 'public.agent_runs', 'SELECT');
  insert into agent_runtime_test_results
  select 'authenticated cannot insert agent runs',
    not has_table_privilege('authenticated', 'public.agent_runs', 'INSERT');
  insert into agent_runtime_test_results
  select 'authenticated cannot execute claim',
    not has_function_privilege('authenticated', 'public.claim_agent_run(text,integer)', 'EXECUTE');
  insert into agent_runtime_test_results
  select 'all seven agent tables force RLS', count(*) = 7
  from pg_class as relation
  join pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname in (
      'agent_runs', 'agent_events', 'agent_approvals', 'agent_clarifications',
      'agent_artifacts', 'agent_usage_items', 'agent_tool_calls'
    )
    and relation.relrowsecurity
    and relation.relforcerowsecurity;
end;
$$;

do $$
declare failed text;
begin
  select string_agg(name, ', ' order by name) into failed
  from agent_runtime_test_results where not ok;
  if failed is not null then
    raise exception 'agent runtime tests failed: %', failed;
  end if;
end;
$$;

select name, ok from agent_runtime_test_results order by name;
rollback;
