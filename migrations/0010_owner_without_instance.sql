-- The reset no longer guards on owner.instance. SQLite cannot drop a column that a CHECK uses, so
-- rebuild the table without it and keep the row. Workers before this migration read the column,
-- so deploy the Worker that no longer reads it first, then apply this migration.
CREATE TABLE owner_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('unpinned', 'pinned', 'resetting')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  email TEXT,
  CHECK (state <> 'pinned' OR email IS NOT NULL),
  CHECK (state <> 'unpinned' OR email IS NULL)
) STRICT;

INSERT INTO owner_next (id, state, generation, email) SELECT id, state, generation, email FROM owner;
DROP TABLE owner;
ALTER TABLE owner_next RENAME TO owner;
