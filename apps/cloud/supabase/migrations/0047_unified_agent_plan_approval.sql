-- U2: 通用 Agent 计划审批仍复用 agent_approvals / awaiting_approval，
-- 不新增第二套状态机。source_call_id + args_hash 将 Gateway 的稳定调用身份
-- 固化到控制面；cost_policy_version 标记服务端权威估算规则。

begin;

alter table public.agent_approvals
  add column if not exists source_call_id text,
  add column if not exists args_hash text,
  add column if not exists cost_policy_version smallint;

alter table public.agent_approvals
  drop constraint if exists agent_approvals_kind_check,
  add constraint agent_approvals_kind_check check (kind in (
    'creative_plan', 'refine_plan',
    'controlled_image_edit_plan', 'controlled_image_edit_revision',
    'unified_agent_plan'
  )),
  add constraint agent_approvals_source_call_check check (
    (kind = 'unified_agent_plan'
      and source_call_id is not null and source_call_id ~ '^[0-9a-f]{64}$'
      and args_hash is not null and args_hash ~ '^[0-9a-f]{64}$'
      and cost_policy_version is not null and cost_policy_version > 0)
    or
    (kind <> 'unified_agent_plan'
      and source_call_id is null and args_hash is null and cost_policy_version is null)
  );

create unique index if not exists agent_approvals_run_source_call_idx
  on public.agent_approvals (run_id, source_call_id)
  where source_call_id is not null;

comment on column public.agent_approvals.source_call_id is
  'Trusted Gateway-derived call id for unified_agent_plan; model cannot provide it.';
comment on column public.agent_approvals.args_hash is
  'Canonical {plan} hash bound to source_call_id; drift fails closed.';
comment on column public.agent_approvals.cost_policy_version is
  'Server-side unified plan cost policy version; never model supplied.';

commit;
