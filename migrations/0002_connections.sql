CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL,
  grant_id TEXT NOT NULL UNIQUE,
  app TEXT NOT NULL CHECK (app IN ('claude-hosted', 'claude-code', 'chatgpt')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;
