-- Keep existing provider identities while widening the closed provider set.
ALTER TABLE local_chat_conversations RENAME COLUMN provider TO previous_provider;
ALTER TABLE local_chat_conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex-local'
  CHECK (provider IN ('codex-local', 'deepseek-cloud', 'dsh-local', 'dsh-cloud'));
UPDATE local_chat_conversations SET provider = previous_provider;
ALTER TABLE local_chat_conversations DROP COLUMN previous_provider;
