-- 0 means allow and 1 means ask. No row is still deny, so deny has one form.
ALTER TABLE permissions ADD COLUMN ask INTEGER NOT NULL DEFAULT 0 CHECK (ask IN (0, 1));

-- A stored call that waits for the owner. uses is a JSON array of {"account","tool"}: every
-- setting the call uses, by the server's account ID. arguments and result are sealed with
-- TOKEN_KEY and bound to this row's ID; both are deleted on a fixed schedule, and the row
-- without its text stays as long as its audit record. An owner's change deletes the text
-- on its target; results are stored only while access holds at the outcome write.
-- No foreign keys: reset needs no deletion order, and rows outlive removed accounts.
CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  call_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  uses TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'approved', 'rejected', 'expired', 'refused')),
  ended_by TEXT CHECK (ended_by IN ('tool', 'connection', 'account')),
  decided_at INTEGER,
  -- A request nonce ties the credential read to the one decision that won.
  claim TEXT,
  outcome TEXT CHECK (outcome IN ('success', 'failed', 'unknown')),
  arguments TEXT,
  result TEXT,
  CHECK ((state = 'refused') = (ended_by IS NOT NULL)),
  CHECK ((state IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CHECK (outcome IS NULL OR state = 'approved'),
  CHECK ((state = 'waiting') = (arguments IS NOT NULL)),
  CHECK (result IS NULL OR outcome IS NOT NULL)
) STRICT;
CREATE INDEX approvals_waiting ON approvals(connection_id, expires_at) WHERE state = 'waiting';
CREATE INDEX approvals_results ON approvals(decided_at) WHERE result IS NOT NULL;
