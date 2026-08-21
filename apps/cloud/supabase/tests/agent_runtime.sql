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

  transitioned := public.commit_agent_checkpoint(
    run_id, first_claim.lease_id, 'runs/test/checkpoint-a.json', repeat('c', 64), 1,
    'parse_intent', 20
  );
  transitioned := public.commit_agent_checkpoint(
    run_id, first_claim.lease_id, 'runs/test/checkpoint-b.json', repeat('d', 64), 1,
    'assign_reference_roles', 30
  );
  insert into agent_runtime_test_results values (
    'repeated checkpoint commits keep lease and advance pointer',
    transitioned.status = 'running'
      and transitioned.lease_id = first_claim.lease_id
      and transitioned.checkpoint_hash = repeat('d', 64)
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
  select 'authenticated cannot commit checkpoint',
    not has_function_privilege(
      'authenticated',
      'public.commit_agent_checkpoint(uuid,uuid,text,text,integer,text,integer)',
      'EXECUTE'
    );
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
declare
  test_user uuid := extensions.gen_random_uuid();
  hold uuid;
  run_id uuid;
  conv_id uuid;
  claimed public.agent_runs;
  reclaimed public.agent_runs;
  transitioned public.agent_runs;
  settled public.agent_runs;
  hold_status text;
  hold_actual integer;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values (
    test_user, '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'agent-settlement@example.test', '', now(), now(), now()
  );

  perform * from public.grant_topup_credits(
    test_user, 'agent-runtime-settlement-topup', 48
  );

  select result.hold_id into hold
  from public.credit_hold(
    test_user,
    'agent-runtime-settlement-hold',
    'agent_controlled_image_edit',
    48
  ) as result;

  insert into public.agent_runs (
    user_id, skill_id, skill_version, kernel_version, status,
    input_count, input_manifest_hash, request_object_key,
    budget_credits, hold_id, pricing_version, queued_at, content_expires_at
  ) values (
    test_user, 'bowerbird-controlled-image-edit', '1.0.0', '0.1.0', 'queued',
    1, repeat('e', 64), 'runs/settlement/request.json',
    48, hold, 1, now(), now() + interval '24 hours'
  ) returning id, conversation_id into run_id, conv_id;

  claimed := public.claim_agent_run('settlement-worker', 60);
  transitioned := public.transition_agent_run(
    run_id, claimed.lease_id, 'running', 'execute', 50
  );
  transitioned := public.transition_agent_run(
    run_id, claimed.lease_id, 'exporting', 'export', 90
  );

  update public.agent_runs
  set lease_expires_at = now() - interval '1 second'
  where id = run_id;
  reclaimed := public.claim_agent_run('settlement-recovery-worker', 60);
  insert into agent_runtime_test_results values (
    'expired exporting run can be reclaimed without repeating provider work',
    reclaimed.id = run_id
      and reclaimed.status = 'leased'
      and reclaimed.lease_id is distinct from claimed.lease_id
  );
  transitioned := public.transition_agent_run(
    run_id, reclaimed.lease_id, 'running', 'resume_finish', 90
  );
  transitioned := public.transition_agent_run(
    run_id, reclaimed.lease_id, 'exporting', 'export', 90
  );

  insert into public.agent_tool_calls (
    run_id, call_id, phase, tool_name, args_hash, status,
    submitted_at, finished_at
  ) values (
    run_id, 'settlement-image-call', 'execute', 'image_generate', repeat('f', 64),
    'succeeded', now(), now()
  );

  insert into public.agent_usage_items (
    run_id, call_id, kind, provider, model, image_count, credits, pricing_version
  ) values (
    run_id, 'settlement-image-call', 'image_generation', 'ark', 'test-image-model', 1, 5, 1
  );

  insert into public.agent_artifacts (
    run_id, conversation_id, kind, role, step_id, object_key,
    mime, bytes, sha256, source_call_id, user_visible, expires_at
  ) values (
    run_id, conv_id, 'final_result', 'final_result', 'final',
    'runs/settlement/artifacts/final.png', 'image/png', 1, repeat('1', 64),
    'settlement-image-call', true, now() + interval '7 days'
  );

  settled := public.settle_agent_run(
    run_id, reclaimed.lease_id, 'succeeded', null, null
  );

  select status, actual_amount into hold_status, hold_actual
  from public.credit_holds
  where id = hold;

  insert into agent_runtime_test_results values (
    'terminal settlement atomically records actual credits',
    settled.status = 'succeeded'
      and settled.actual_credits = 5
      and settled.lease_id is null
      and settled.finished_at is not null
      and hold_status = 'confirmed'
      and hold_actual = 5
  );

  insert into agent_runtime_test_results
  select 'authenticated cannot execute agent settlement',
    not has_function_privilege(
      'authenticated',
      'public.settle_agent_run(uuid,uuid,text,text,text)',
      'EXECUTE'
    );

  insert into agent_runtime_test_results
  select 'authenticated cannot execute unleased cancellation settlement',
    not has_function_privilege(
      'authenticated',
      'public.cancel_unleased_agent_run(uuid)',
      'EXECUTE'
    );
end;
$$;

do $$
declare
  test_user uuid := extensions.gen_random_uuid();
  hold uuid;
  run_id uuid;
  cancelled record;
  hold_status text;
  hold_actual integer;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values (
    test_user, '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'agent-cancel@example.test', '', now(), now(), now()
  );

  perform * from public.grant_topup_credits(test_user, 'agent-runtime-cancel-topup', 48);
  select result.hold_id into hold
  from public.credit_hold(
    test_user, 'agent-runtime-cancel-hold', 'agent_controlled_image_edit', 48
  ) as result;

  insert into public.agent_runs (
    user_id, skill_id, skill_version, kernel_version, status,
    input_count, input_manifest_hash, request_object_key,
    budget_credits, hold_id, pricing_version, content_expires_at
  ) values (
    test_user, 'bowerbird-controlled-image-edit', '0.1.0', '0.1.0',
    'awaiting_result_feedback', 1, repeat('9', 64), 'runs/cancel/request.json',
    48, hold, 1, now() + interval '24 hours'
  ) returning id into run_id;

  insert into public.agent_tool_calls (
    run_id, call_id, phase, tool_name, args_hash, status, submitted_at, finished_at
  ) values (
    run_id, 'cancel-vision-call', 'diagnose_feedback', 'understand_image', repeat('8', 64),
    'succeeded', now(), now()
  );
  insert into public.agent_usage_items (
    run_id, call_id, kind, provider, model, credits, pricing_version
  ) values (
    run_id, 'cancel-vision-call', 'vision_call', 'ark', 'test-vision-model', 1, 1
  );

  select * into cancelled from public.cancel_unleased_agent_run(run_id);
  select status, actual_amount into hold_status, hold_actual
  from public.credit_holds where id = hold;

  insert into agent_runtime_test_results values (
    'unleased cancellation confirms durable usage and releases the remainder',
    cancelled.status = 'cancelled'
      and cancelled.actual_credits = 1
      and hold_status = 'confirmed'
      and hold_actual = 1
  );
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
