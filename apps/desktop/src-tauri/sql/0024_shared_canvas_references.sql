-- Share reference inputs within a project while retaining their original thread and execution identity.
DROP TRIGGER canvas_edges_validate_insert;

CREATE TRIGGER canvas_edges_validate_insert
BEFORE INSERT ON canvas_edges
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM canvas_nodes n
    WHERE n.project_id = NEW.project_id
      AND n.id IN (NEW.from_node_id, NEW.to_node_id)
      AND n.thread_id IS NOT NULL
      AND n.thread_id <> NEW.thread_id
      AND NOT (NEW.kind = 'input' AND n.id = NEW.from_node_id
               AND n.kind = 'asset' AND COALESCE(n.role, '') = 'reference')
  ) THEN RAISE(ABORT, 'canvas edge crosses creative threads') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM canvas_nodes f, canvas_nodes t
    WHERE f.project_id = NEW.project_id AND f.id = NEW.from_node_id
      AND t.project_id = NEW.project_id AND t.id = NEW.to_node_id
      AND (
        (NEW.kind = 'input' AND f.kind IN ('asset', 'prompt') AND t.kind IN ('prompt', 'agent_group')) OR
        (NEW.kind = 'produced' AND f.kind IN ('prompt', 'agent_group') AND t.kind = 'asset' AND t.role IN ('output', 'final')) OR
        (NEW.kind IN ('continued', 'retry', 'branch') AND f.kind = 'asset' AND f.role IN ('output', 'intermediate', 'final') AND t.kind = 'prompt') OR
        (NEW.kind = 'agent_step' AND f.kind = 'agent_group' AND t.kind = 'asset' AND t.role IN ('intermediate', 'final'))
      )
  ) THEN RAISE(ABORT, 'invalid canvas edge endpoints') END;

  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable(node_id) AS (
      SELECT NEW.to_node_id
      UNION
      SELECT e.to_node_id
      FROM canvas_edges e JOIN reachable r ON e.from_node_id = r.node_id
      WHERE e.project_id = NEW.project_id AND e.thread_id = NEW.thread_id
    )
    SELECT 1 FROM reachable WHERE node_id = NEW.from_node_id
  ) THEN RAISE(ABORT, 'canvas edge would create a cycle') END;
END;
