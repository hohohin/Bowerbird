CREATE TABLE library_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL UNIQUE
);
INSERT INTO library_identity(singleton, id) VALUES (1, lower(hex(randomblob(16))));
