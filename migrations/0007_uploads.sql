-- uploads holds single-use files for one live connection until expires_at.
-- file is a sealed reference to encrypted bytes; identity reserves it for a call.
-- calls.also records the additional account/tool pairs used by a call.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY NOT NULL,
  link TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  file TEXT,
  identity TEXT
) STRICT;
CREATE INDEX uploads_expiry ON uploads(expires_at);
ALTER TABLE calls ADD COLUMN also TEXT;
