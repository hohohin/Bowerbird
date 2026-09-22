-- Preserve old single-run documents while protecting every active parallel run.
DROP TRIGGER canvas_workflows_protect_running_project;
CREATE TRIGGER canvas_workflows_protect_running_project
BEFORE DELETE ON projects
WHEN EXISTS (SELECT 1 FROM canvas_workflows WHERE project_id=OLD.id
  AND (json_extract(document_json, '$.run.status') IN ('running','waiting')
    OR EXISTS (SELECT 1 FROM json_each(document_json, '$.runs')
      WHERE json_extract(value, '$.status') IN ('running','waiting'))))
BEGIN
  SELECT RAISE(ABORT, '请先停止项目内的工作流');
END;
