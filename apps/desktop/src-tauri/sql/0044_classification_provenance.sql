-- Creation evidence is distinct from current label membership. Historical origins
-- cannot be inferred from tags.source or today's associated images.
ALTER TABLE tags ADD COLUMN classification_provenance TEXT;
