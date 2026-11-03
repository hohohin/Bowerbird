-- Explicitly cleaned-up missing originals remain addressable by projects and canvas nodes.
-- This is not a recycling operation and does not remove creative records or cached previews.
CREATE TABLE removed_missing_asset_originals (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  path TEXT NOT NULL
);
