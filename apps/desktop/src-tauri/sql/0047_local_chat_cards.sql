ALTER TABLE local_chat_turns ADD COLUMN card_defaults_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE local_chat_conversations ADD COLUMN provider_tool_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE local_chat_card_actions (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES local_chat_conversations(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL REFERENCES local_chat_turns(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL,
 args_json TEXT NOT NULL CHECK(json_valid(args_json)),
 cards_json TEXT NOT NULL CHECK(json_valid(cards_json)),
 footprint_json TEXT NOT NULL CHECK(json_valid(footprint_json)),
 status TEXT NOT NULL CHECK(status IN ('created','undone')),
 created_at INTEGER NOT NULL,
 undone_at INTEGER,
 UNIQUE(conversation_id,turn_id,call_id)
);
CREATE INDEX idx_local_chat_actions ON local_chat_card_actions(conversation_id,created_at,id);
