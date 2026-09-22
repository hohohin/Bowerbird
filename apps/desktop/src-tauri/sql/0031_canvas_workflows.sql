-- Editable workflow definitions are not execution-history canvas edges.
CREATE TABLE canvas_workflows (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  CHECK (json_extract(document_json, '$.schema_version') = 1)
);

CREATE TRIGGER canvas_workflows_protect_running_project
BEFORE DELETE ON projects
WHEN EXISTS (SELECT 1 FROM canvas_workflows WHERE project_id=OLD.id
  AND json_extract(document_json, '$.run.status') IN ('running','waiting'))
BEGIN
  SELECT RAISE(ABORT, '请先停止项目内的工作流');
END;
