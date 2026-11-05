-- Connection membership and explicit independent collection are distinct from canvas visibility.
CREATE TABLE disconnected_library_assets (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE
);
CREATE TABLE independent_library_assets (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE
);
-- Existing library members outside connected directories have independent evidence.
-- Do not guess which already-disconnected legacy assets came from old connections.
INSERT INTO independent_library_assets(asset_id)
SELECT e.asset_id FROM external_assets e WHERE e.library_member=1
AND NOT EXISTS(SELECT 1 FROM connected_entries c WHERE c.asset_id=e.asset_id);
