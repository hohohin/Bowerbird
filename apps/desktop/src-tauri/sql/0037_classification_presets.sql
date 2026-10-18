-- Main-library startup seeds presets once; folder sessions keep their own labels.
ALTER TABLE local_classification_state ADD COLUMN presets_initialized INTEGER NOT NULL DEFAULT 0;
