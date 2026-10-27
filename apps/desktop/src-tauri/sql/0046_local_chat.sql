-- Local chat owns its execution/history; generation task_queue is deliberately separate.
CREATE TABLE local_chat_conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE REFERENCES creative_threads(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL UNIQUE REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'codex-local' CHECK(provider='codex-local'),
  provider_thread_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('idle','running','stopping','stopped','interrupted','failed')),
  revision INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_local_chat_project ON local_chat_conversations(project_id,updated_at DESC,id);
CREATE TABLE local_chat_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES local_chat_conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  provider_turn_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','stopping','done','stopped','interrupted','failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_local_chat_active_turn ON local_chat_turns(conversation_id) WHERE status IN ('running','stopping');
CREATE TABLE local_chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES local_chat_conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES local_chat_turns(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  text TEXT NOT NULL,
  reference_asset_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reference_asset_ids)),
  status TEXT NOT NULL CHECK(status IN ('running','done','stopped','interrupted','failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_local_chat_messages ON local_chat_messages(conversation_id,created_at,id);
