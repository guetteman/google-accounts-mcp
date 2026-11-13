CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  link TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  file TEXT
);
CREATE INDEX uploads_expiry ON uploads(expires_at);
ALTER TABLE calls ADD COLUMN also TEXT;
