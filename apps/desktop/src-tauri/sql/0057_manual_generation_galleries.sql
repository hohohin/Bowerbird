-- Display aliases only; preserve generation/session IDs, files and graph bindings.
CREATE TABLE generation_gallery_merges (
    source_key TEXT PRIMARY KEY NOT NULL,
    group_key TEXT NOT NULL
);
CREATE INDEX idx_generation_gallery_merges_group ON generation_gallery_merges(group_key);
