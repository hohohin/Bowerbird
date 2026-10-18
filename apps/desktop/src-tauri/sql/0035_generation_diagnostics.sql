-- Diagnostic receipts are not runnable tasks. In particular, rejected requests must
-- survive restart without entering the generation worker's recovery queue.
CREATE TABLE generation_diagnostics (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  turn_key TEXT,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  resolved_references_json TEXT CHECK(resolved_references_json IS NULL OR json_valid(resolved_references_json)),
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX generation_diagnostics_job ON generation_diagnostics(job_id, created_at);
