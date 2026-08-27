-- V4: freeze the selected project visual profile identity on each Agent Run.
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS visual_profile_id text,
  ADD COLUMN IF NOT EXISTS visual_profile_version integer,
  ADD COLUMN IF NOT EXISTS visual_profile_hash text;

ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_visual_profile_trace_all_or_none CHECK (
    (visual_profile_id IS NULL AND visual_profile_version IS NULL AND visual_profile_hash IS NULL)
    OR
    (length(visual_profile_id) BETWEEN 1 AND 120
      AND visual_profile_version >= 1
      AND visual_profile_hash ~ '^[0-9a-f]{64}$')
  );
