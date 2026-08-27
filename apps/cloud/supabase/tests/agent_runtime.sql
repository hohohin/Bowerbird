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
  clarification_pricing integer;
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
  -- 0040/0043 回归：取消时 pending 审批必须一并置 expired（该 UPDATE 的裸
  -- status 曾与 RETURNS TABLE(status) 输出变量歧义，解析期 42702）。
  insert into public.agent_approvals (
    run_id, kind, proposal_object_key, proposal_hash, expires_at
  ) values (
    run_id, 'refine_plan', 'runs/cancel/approval.json', repeat('a', 64),
    now() + interval '24 hours'
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

  insert into agent_runtime_test_results
  select 'unleased cancellation expires the pending approval',
    status = 'expired' and decided_at is not null
  from public.agent_approvals where agent_approvals.run_id = run_id;

  select result.hold_id, result.pricing_version into hold, clarification_pricing
  from public.credit_hold(
    test_user, 'agent-runtime-clarification-cancel-hold', 'agent_controlled_image_edit_min', 9
  ) as result;
  insert into public.agent_runs (
    user_id, skill_id, skill_version, kernel_version, status,
    input_count, input_manifest_hash, request_object_key,
    budget_credits, hold_id, pricing_version, content_expires_at
  ) values (
    test_user, 'bowerbird-controlled-image-edit', '0.1.1', '0.1.0',
    'awaiting_clarification', 0, repeat('7', 64), 'runs/clarification-cancel/request.json',
    9, hold, clarification_pricing, now() - interval '1 second'
  ) returning id into run_id;
  select * into cancelled from public.cancel_unleased_agent_run(run_id);
  insert into agent_runtime_test_results values (
    'expired clarification can be cancelled without a lease',
    cancelled.status = 'cancelled' and cancelled.actual_credits = 0
  );
end;
$$;

do $$
declare
  user_a uuid := extensions.gen_random_uuid();
  user_b uuid := extensions.gen_random_uuid();
  hold_a uuid;
  hold_a_rejected uuid;
  hold_b uuid;
  pricing_a integer;
  pricing_a_rejected integer;
  pricing_b integer;
  run_a uuid := extensions.gen_random_uuid();
  conversation_a uuid := extensions.gen_random_uuid();
  created public.agent_runs;
  replayed public.agent_runs;
  rejected_detail text;
  marker_count integer;
  marker_keys integer;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values
    (user_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'agent-capacity-a@example.test', '', now(), now(), now()),
    (user_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'agent-capacity-b@example.test', '', now(), now(), now());

  perform * from public.grant_topup_credits(user_a, 'agent-capacity-topup-a', 48);
  perform * from public.grant_topup_credits(user_b, 'agent-capacity-topup-b', 48);
  select result.hold_id, result.pricing_version into hold_a, pricing_a
  from public.credit_hold(user_a, 'agent-capacity-hold-a', 'agent_controlled_image_edit_min', 9) as result;
  select result.hold_id, result.pricing_version into hold_a_rejected, pricing_a_rejected
  from public.credit_hold(user_a, 'agent-capacity-hold-a-rejected', 'agent_controlled_image_edit_min', 9) as result;
  select result.hold_id, result.pricing_version into hold_b, pricing_b
  from public.credit_hold(user_b, 'agent-capacity-hold-b', 'agent_controlled_image_edit_min', 9) as result;

  created := public.create_agent_run_guarded(
    run_a, conversation_a, user_a, 'bowerbird-controlled-image-edit', '0.1.1', '0.1.0',
    0, repeat('a', 64), 'runs/capacity-a/inputs/request.json', 'codex', 9,
    hold_a, pricing_a, now() + interval '24 hours', 1, 10
  );
  replayed := public.create_agent_run_guarded(
    extensions.gen_random_uuid(), extensions.gen_random_uuid(), user_a,
    'bowerbird-controlled-image-edit', '0.1.1', '0.1.0', 0, repeat('a', 64),
    'runs/ignored/inputs/request.json', 'codex', 9, hold_a, pricing_a,
    now() + interval '24 hours', 1, 10
  );
  insert into agent_runtime_test_results values (
    'guarded create replays the database winner by hold',
    created.id = run_a and replayed.id = run_a
      and replayed.request_object_key = created.request_object_key
      and created.image_provider = 'codex'
  );

  insert into public.agent_tool_calls (
    run_id, call_id, phase, tool_name, args_hash, status, finished_at
  ) values (
    run_a, repeat('d', 64), 'execute_approved_plan', 'generate_image',
    repeat('e', 64), 'succeeded', now()
  );
  insert into public.agent_local_tasks (
    run_id, call_id, provider, step_id, params_object_key, status, expires_at
  ) values (
    run_a, repeat('d', 64), 'codex', 'step-1',
    'runs/capacity-a/local/codex.json', 'completed', now() + interval '30 minutes'
  );
  insert into public.agent_usage_items (
    run_id, call_id, kind, provider, model, image_count, credits, pricing_version
  ) values (
    run_a, repeat('d', 64), 'image_generation', 'codex', 'codex-cli', 1, 0, pricing_a
  );
  insert into agent_runtime_test_results
  select 'Codex local task and zero-credit usage constraints accept the provider',
    exists (
      select 1 from public.agent_local_tasks
      where run_id = run_a and call_id = repeat('d', 64) and provider = 'codex'
    ) and exists (
      select 1 from public.agent_usage_items
      where run_id = run_a and call_id = repeat('d', 64) and provider = 'codex' and credits = 0
    );

  rejected_detail := null;
  begin
    perform public.create_agent_run_guarded(
      extensions.gen_random_uuid(), extensions.gen_random_uuid(), user_a,
      'bowerbird-controlled-image-edit', '0.1.1', '0.1.0', 0, repeat('f', 64),
      'runs/ignored/inputs/request.json', 'cloud', 9, hold_a, pricing_a,
      now() + interval '24 hours', 1, 10
    );
  exception when sqlstate '55000' then
    get stacked diagnostics rejected_detail = PG_EXCEPTION_DETAIL;
  end;
  insert into agent_runtime_test_results values (
    'guarded create rejects mismatched idempotent replay',
    rejected_detail = 'agent_idempotency_mismatch'
  );

  rejected_detail := null;
  begin
    perform public.create_agent_run_guarded(
      extensions.gen_random_uuid(), extensions.gen_random_uuid(), user_a,
      'bowerbird-controlled-image-edit', '0.1.1', '0.1.0', 0, repeat('b', 64),
      'runs/capacity-a-rejected/inputs/request.json', 'cloud', 9,
      hold_a_rejected, pricing_a_rejected, now() + interval '24 hours', 1, 10
    );
  exception when raise_exception then
    get stacked diagnostics rejected_detail = PG_EXCEPTION_DETAIL;
  end;
  insert into agent_runtime_test_results values (
    'guarded create enforces per-user parallel capacity',
    rejected_detail = 'agent_user_parallel_limit'
  );

  rejected_detail := null;
  begin
    perform public.create_agent_run_guarded(
      extensions.gen_random_uuid(), extensions.gen_random_uuid(), user_b,
      'bowerbird-controlled-image-edit', '0.1.1', '0.1.0', 0, repeat('c', 64),
      'runs/capacity-b/inputs/request.json', 'cloud', 9,
      hold_b, pricing_b, now() + interval '24 hours', 1, 1
    );
  exception when raise_exception then
    get stacked diagnostics rejected_detail = PG_EXCEPTION_DETAIL;
  end;
  insert into agent_runtime_test_results values (
    'guarded create enforces project-wide active capacity',
    rejected_detail = 'agent_global_capacity'
  );

  perform public.cancel_unleased_agent_run(run_a);
  select count(*)::integer into marker_count
  from public.credit_transactions
  where hold_id = hold_a and kind = 'adjust' and meta ->> 'entity_type' = 'agent_run';
  select count(*)::integer into marker_keys
  from public.credit_transactions as tx,
       lateral jsonb_object_keys(tx.meta) as key
  where tx.hold_id = hold_a and tx.kind = 'adjust' and tx.meta ->> 'entity_type' = 'agent_run';
  insert into agent_runtime_test_results values (
    'terminal run writes one content-free billing marker',
    marker_count = 1 and marker_keys = 8
  );

  insert into agent_runtime_test_results
  select 'authenticated cannot execute guarded Agent creation',
    not has_function_privilege(
      'authenticated',
      'public.create_agent_run_guarded(uuid,uuid,uuid,text,text,text,integer,text,text,text,integer,uuid,integer,timestamptz,integer,integer)',
      'EXECUTE'
    );
end;
$$;

do $$
declare
  test_user uuid := extensions.gen_random_uuid();
  hold uuid;
  test_run_id uuid;
  conv_id uuid;
  test_call_id text := repeat('b', 64);
  rendered_count integer;
  duplicate_rejected boolean := false;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at
  ) values (
    test_user, '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'agent-runtime-html-render@example.test', '', now(), now(), now()
  );

  select result.hold_id into hold
  from public.credit_hold(test_user, 'agent-runtime-html-hold', 'agent_smart_refinement', 15) as result;

  insert into public.agent_runs (
    user_id, skill_id, skill_version, kernel_version, status,
    input_count, input_manifest_hash, request_object_key,
    budget_credits, hold_id, pricing_version, queued_at, content_expires_at
  ) values (
    test_user, 'bowerbird-html-layout-render', '0.0.1', '0.1.0', 'queued',
    1, repeat('c', 64), 'runs/html-render/request.json',
    15, hold, 1, now(), now() + interval '24 hours'
  ) returning id, conversation_id into test_run_id, conv_id;

  insert into public.agent_tool_calls (
    run_id, call_id, phase, tool_name, args_hash, status, submitted_at
  ) values (
    test_run_id, test_call_id, 'render_once', 'render_html', repeat('d', 64), 'submitted', now()
  );

  insert into public.agent_usage_items (
    run_id, call_id, kind, provider, model, credits, pricing_version
  ) values (
    test_run_id, test_call_id, 'html_render', 'renderer', 'offline-chromium', 0, 1
  );

  insert into agent_runtime_test_results values (
    'html render zero-credit usage kind and provider accepted',
    exists (
      select 1 from public.agent_usage_items as usage
      where usage.run_id = test_run_id and usage.call_id = test_call_id
        and usage.kind = 'html_render' and usage.provider = 'renderer' and usage.credits = 0
    )
  );

  -- 一次 render_html 调用产出 manifest + 整页 + 切片（新角色全部通过 CHECK）。
  insert into public.agent_artifacts (
    run_id, conversation_id, kind, role, step_id, object_key,
    mime, bytes, sha256, source_call_id, user_visible, expires_at
  )
  values
    (test_run_id, conv_id, 'render_manifest', 'render_manifest', 'render',
     'runs/' || test_run_id || '/artifacts/' || test_call_id || '-manifest.json',
     'application/json', 24, repeat('1', 64), test_call_id, false, now() + interval '7 days'),
    (test_run_id, conv_id, 'full_page_screenshot', 'full_page_screenshot', 'render',
     'runs/' || test_run_id || '/artifacts/' || test_call_id || '-full.png',
     'image/png', 10, repeat('2', 64), test_call_id, true, now() + interval '7 days'),
    (test_run_id, conv_id, 'slice_screenshot', 'slice_screenshot', 'render',
     'runs/' || test_run_id || '/artifacts/' || test_call_id || '-slice-0001.png',
     'image/png', 4, repeat('3', 64), test_call_id, true, now() + interval '7 days');

  select count(*) into rendered_count
  from public.agent_artifacts as artifact
  where artifact.run_id = test_run_id and artifact.source_call_id = test_call_id;

  insert into agent_runtime_test_results values (
    'html render roles accepted with multiple outputs per call',
    rendered_count = 3
  );

  -- 同 object_key 重放：唯一索引拒绝（幂等语义 = 同 key 冲突即失败，由 Edge 先查再写）。
  begin
    insert into public.agent_artifacts (
      run_id, conversation_id, kind, role, step_id, object_key,
      mime, bytes, sha256, source_call_id, user_visible, expires_at
    ) values (
      test_run_id, conv_id, 'full_page_screenshot', 'full_page_screenshot', 'render',
      'runs/' || test_run_id || '/artifacts/' || test_call_id || '-full.png',
      'image/png', 10, repeat('9', 64), test_call_id, true, now() + interval '7 days'
    );
  exception when unique_violation then
    duplicate_rejected := true;
  end;

  insert into agent_runtime_test_results values (
    'render artifact replay rejected by object key uniqueness',
    duplicate_rejected
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
