CREATE INDEX calls_connection ON calls(connection_id);
CREATE INDEX calls_outcome ON calls(outcome);
CREATE INDEX approvals_call ON approvals(call_id);
-- Every account that a call uses: the one it names and each other one in calls.also,
-- a JSON array of {"account": <account ID>, "tool": <tool name>}.
-- It only repeats what calls holds, so that the account filter can find a record.
CREATE TABLE call_accounts (
  account_id TEXT NOT NULL,
  call_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, call_id)
) WITHOUT ROWID;
INSERT INTO call_accounts
SELECT account_id, id FROM calls WHERE account_id IS NOT NULL
UNION
SELECT json_extract(u.value, '$.account'), c.id FROM calls c, json_each(c.also) u;
CREATE TRIGGER calls_accounts AFTER INSERT ON calls
BEGIN
  INSERT OR IGNORE INTO call_accounts SELECT NEW.account_id, NEW.id WHERE NEW.account_id IS NOT NULL;
  INSERT OR IGNORE INTO call_accounts SELECT json_extract(value, '$.account'), NEW.id FROM json_each(NEW.also);
END;
