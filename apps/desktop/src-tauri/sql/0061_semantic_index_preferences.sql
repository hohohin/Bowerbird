CREATE TABLE semantic_index_preferences (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    automatic_enabled INTEGER NOT NULL DEFAULT 1 CHECK(automatic_enabled IN (0, 1)),
    interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK(interval_minutes IN (15, 60)),
    include_generated INTEGER NOT NULL DEFAULT 1 CHECK(include_generated IN (0, 1)),
    policy_revision INTEGER NOT NULL DEFAULT 0,
    round_kind TEXT CHECK(round_kind IN ('automatic', 'manual')),
    round_started_at INTEGER,
    audit_pending INTEGER NOT NULL DEFAULT 0 CHECK(audit_pending IN (0, 1)),
    last_update_at INTEGER,
    next_update_at INTEGER,
    CHECK ((round_kind IS NULL) = (round_started_at IS NULL))
);
INSERT INTO semantic_index_preferences(id) VALUES(1);

-- Existing enabled libraries continue their current work. A missing index row
-- remains distinguishable from an explicit pause or disable.
UPDATE semantic_index_preferences SET round_kind='automatic',round_started_at=unixepoch(),audit_pending=1
WHERE EXISTS(SELECT 1 FROM semantic_index_state WHERE id=1 AND run_state='running');
