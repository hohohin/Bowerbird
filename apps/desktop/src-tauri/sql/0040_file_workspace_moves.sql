-- A committed marker lets startup finish the config switch after a process interruption.
CREATE TABLE file_workspace_moves (
    id TEXT PRIMARY KEY,
    committed_at INTEGER NOT NULL
);
