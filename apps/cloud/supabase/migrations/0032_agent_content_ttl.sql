-- A5-T4: make short-lived Agent content cleanup observable and idempotent.
-- Object keys/hashes remain as technical metadata; content_deleted_at means the
-- private object bytes have been removed. Events are deleted because their
-- display_payload is itself user-visible content.

alter table public.agent_runs
  add column content_deleted_at timestamptz;

alter table public.agent_approvals
  add column content_deleted_at timestamptz;

alter table public.agent_clarifications
  add column content_deleted_at timestamptz;

alter table public.agent_local_tasks
  add column content_deleted_at timestamptz;

drop index if exists public.agent_runs_content_expiry_idx;
create index agent_runs_content_expiry_idx
  on public.agent_runs (content_expires_at)
  where content_deleted_at is null;

create index agent_approvals_content_expiry_idx
  on public.agent_approvals (expires_at)
  where content_deleted_at is null;

create index agent_clarifications_content_expiry_idx
  on public.agent_clarifications (expires_at)
  where content_deleted_at is null;

drop index if exists public.agent_local_tasks_stale_idx;
create index agent_local_tasks_stale_idx
  on public.agent_local_tasks (status, expires_at)
  where content_deleted_at is null;
