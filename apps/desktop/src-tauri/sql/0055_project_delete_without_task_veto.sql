-- The existing project-delete confirmation also abandons unfinished work.
-- Keep FK detachment, canvas cascades and backfill tombstones; task state is
-- execution evidence, not a veto on deleting its former project.
DROP TRIGGER IF EXISTS projects_block_delete_while_running;
DROP TRIGGER IF EXISTS canvas_workflows_protect_running_project;
