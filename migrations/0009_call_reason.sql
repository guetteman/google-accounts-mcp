-- calls.reason is the failure code of a refused or failed call, never its message.
-- No CHECK constraint: a later version adds codes without rebuilding this table.
ALTER TABLE calls ADD COLUMN reason TEXT;
