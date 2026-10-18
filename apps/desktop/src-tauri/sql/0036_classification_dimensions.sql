-- Internal routing only. Existing tags/assignments stay intact; unresolved labels
-- are assigned lazily from their name and definition when classification runs.
ALTER TABLE tags ADD COLUMN classification_dimension TEXT
    CHECK (classification_dimension IN ('subject','type','style','mood','other'));
