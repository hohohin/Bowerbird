-- Classification is independent of caption/reverse-prompt analyses.
ALTER TABLE tags ADD COLUMN classification_description TEXT NOT NULL DEFAULT '';
ALTER TABLE tags ADD COLUMN classification_enabled INTEGER NOT NULL DEFAULT 1;
-- Old tag.source describes the label creator, not who assigned it. Never infer training examples from it.
ALTER TABLE asset_tags ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE local_classification_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO local_classification_state(id) VALUES (1);

CREATE TABLE local_visual_observations (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE local_tag_rejections (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(asset_id, tag_id)
);
CREATE TABLE local_label_jobs (
  tag_id TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE
);

-- Keep all used historical categories. Remove only untouched, unused seed rows.
DELETE FROM tags WHERE source = 'auto'
AND id IN ('cat_portrait','cat_landscape','cat_still','cat_food','cat_animal',
           'cat_arch','cat_abstract','cat_illustration','cat_interior','cat_street')
AND NOT EXISTS (SELECT 1 FROM asset_tags WHERE tag_id = tags.id);
