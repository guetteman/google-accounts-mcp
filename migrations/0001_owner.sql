-- The deploy's one owner. A deploy starts unpinned at generation 1; the first verified request for
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
  CHECK (state <> 'pinned' OR email IS NOT NULL),
  CHECK (state <> 'unpinned' OR email IS NULL)
) STRICT;

INSERT INTO owner (id, state, generation) VALUES (1, 'unpinned', 1);
