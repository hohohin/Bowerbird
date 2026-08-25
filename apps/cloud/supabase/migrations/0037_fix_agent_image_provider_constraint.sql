-- A7-T5: the deployed 0028 migration predates the Codex provider value even
-- though the repository copy now documents it. Never edit an applied migration
-- to repair production state; replace the named constraint in a new migration.

alter table public.agent_runs
  drop constraint if exists agent_runs_image_provider_check;

alter table public.agent_runs
  add constraint agent_runs_image_provider_check
  check (image_provider in ('cloud', 'jimeng', 'codex'));

comment on constraint agent_runs_image_provider_check on public.agent_runs is
  'Cloud runs execute on VPS; jimeng and codex runs park approved image steps for the desktop CLI.';
