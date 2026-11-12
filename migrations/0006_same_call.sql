-- once holds claims, times, and Gmail result IDs for calls that create or send mail.
-- It never holds argument text or mail content. draft_id is nullable for plain sends.
CREATE TABLE once (
  identity TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'unknown')),
  claim TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  draft_id TEXT,
  message_id TEXT,
  thread_id TEXT,
  CHECK ((state = 'done') = (message_id IS NOT NULL)),
  CHECK ((state = 'done') = (thread_id IS NOT NULL))
) STRICT;
CREATE INDEX once_expiry ON once(expires_at);

-- approvals keeps the sealed call and the identity used to find a waiting approval.
-- Existing approvals and tools that only read do not have an identity.
ALTER TABLE approvals ADD COLUMN identity TEXT;
