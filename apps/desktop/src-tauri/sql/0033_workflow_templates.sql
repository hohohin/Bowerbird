CREATE TABLE workflow_templates (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    document_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
