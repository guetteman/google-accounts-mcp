CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL,
  sub TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  hd TEXT,
  state TEXT NOT NULL CHECK (state IN ('live', 'removed')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  version INTEGER NOT NULL CHECK (version >= 1),
  scopes TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('ready', 'needs_reconnect', 'blocked_by_admin')),
  blocked_until INTEGER,
  refresh_token TEXT,
  access_token TEXT,
  access_expires_at INTEGER,
  CHECK (
    (state = 'live' AND health <> 'needs_reconnect' AND refresh_token IS NOT NULL)
    OR ((state = 'removed' OR health = 'needs_reconnect') AND refresh_token IS NULL AND access_token IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX accounts_live_sub ON accounts(sub) WHERE state = 'live';
CREATE UNIQUE INDEX accounts_live_email ON accounts(email) WHERE state = 'live';
