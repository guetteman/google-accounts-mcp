-- The deploy's one owner. A deploy starts unpinned at generation 1; the first sign-in as
-- OWNER_EMAIL pins it. The generation goes up by one only when a reset begins. instance is a
-- random number fixed when the database is created; the reset guards every statement on it, so a
-- reset confirmed for one database changes nothing in another.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance INTEGER NOT NULL DEFAULT (abs(random() % 9007199254740991) + 1)
    CHECK (instance BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('unpinned', 'pinned', 'resetting')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  email TEXT,
  google_sub TEXT,
  CHECK (state <> 'pinned' OR (email IS NOT NULL AND google_sub IS NOT NULL)),
  CHECK (state <> 'unpinned' OR (email IS NULL AND google_sub IS NULL))
) STRICT;

INSERT INTO owner (id, state, generation) VALUES (1, 'unpinned', 1);

-- One row per signed-in browser. token_hash is the hex SHA-256 of the cookie's token; the
-- token itself is never stored. Times are milliseconds since the Unix epoch. A session counts
-- only while its generation equals the owner's.
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;
