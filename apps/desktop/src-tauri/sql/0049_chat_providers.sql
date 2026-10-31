-- Every pre-0049 row is constrained to codex-local. Replace only that column,
-- keeping the parent table identity and all turn/message/action foreign keys.
ALTER TABLE local_chat_conversations DROP COLUMN provider;
ALTER TABLE local_chat_conversations ADD COLUMN provider TEXT NOT NULL
  DEFAULT 'codex-local' CHECK(provider IN ('codex-local','deepseek-cloud'));
