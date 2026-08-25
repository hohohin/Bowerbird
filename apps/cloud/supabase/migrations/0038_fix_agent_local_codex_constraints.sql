-- A7-T5: the deployed 0028 migration carried the initial Jimeng-only checks.
-- Codex was added to the repository copy before release, but applied migration
-- history is immutable. Repair both remaining provider checks explicitly.

alter table public.agent_local_tasks
  drop constraint if exists agent_local_tasks_provider_check;

alter table public.agent_local_tasks
  add constraint agent_local_tasks_provider_check
  check (provider in ('jimeng', 'codex'));

alter table public.agent_usage_items
  drop constraint if exists agent_usage_items_provider_check;

alter table public.agent_usage_items
  add constraint agent_usage_items_provider_check
  check (provider in ('deepseek', 'ark', 'jimeng', 'codex'));

comment on constraint agent_local_tasks_provider_check on public.agent_local_tasks is
  'Only the two desktop-local image providers may receive parked Agent tasks.';

comment on constraint agent_usage_items_provider_check on public.agent_usage_items is
  'Trusted Agent usage supports managed providers plus zero-credit desktop Jimeng/Codex calls.';
