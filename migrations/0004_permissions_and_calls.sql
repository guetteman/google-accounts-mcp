-- A row grants access; no row is deny. Removed accounts and ended connections cannot
-- use old rows, and their IDs are never reused. Owner reset clears both tables.
CREATE TABLE permissions (
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  PRIMARY KEY (connection_id, account_id, tool)
);

-- A record never holds agent text: IDs and tool names are resolved by the server.
-- No foreign keys: records survive removal, and reset needs no deletion order.
-- No CHECK on tool or outcome: adding tools or future approval outcomes must not
-- require rebuilding this table. The application's types constrain writes.
CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT,
  tool TEXT,
  at INTEGER NOT NULL,
  outcome TEXT
);
