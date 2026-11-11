import { endApprovals, changeGuard } from "../approvals/store";
import { Effect } from "effect";
import { WriteUncertain } from "../db";
import type { Owner } from "../owner/owner";
import type { AccountId } from "../accounts/model";
import type { ConnectionId } from "../connections/model";
import { activeWhere } from "../connections/store";
import type { AccountTool } from "../mcp/tools";

export type Setting = "deny" | "ask" | "allow";

/** SQL expressions come from callers, never request text. Accounts are aliased as a. */
export const permittedWhere = ({
  connection,
  tool,
  now,
  ownerEmail,
}: {
  connection: string;
  tool?: string;
  now: string;
  ownerEmail: string;
}) => `EXISTS (SELECT 1 FROM permissions p JOIN connections c ON c.id = p.connection_id
  WHERE p.account_id = a.id AND c.id = ${connection} AND c.generation = a.generation
  ${tool ? `AND p.tool = ${tool}` : ""} AND a.state = 'live'
  AND ${activeWhere({ now, ownerEmail })})`;

// No row is deny. Both writes use the same live-account/active-connection guard;
// rows of a removed account or ended connection can never grant access again.
export const setPermission = (
  db: D1Database,
  owner: Owner,
  change: { connectionId: ConnectionId; accountId: AccountId; tool: AccountTool; setting: Setting },
  now: number,
) =>
  Effect.gen(function* () {
    const guard = changeGuard("tool", {
      connection: "?1",
      account: "?2",
      generation: "?4",
      ownerEmail: "?5",
      now: "?6",
    });
    const values = [
      change.connectionId,
      change.accountId,
      change.tool,
      owner.generation,
      owner.email,
      now,
    ];
    const results = yield* Effect.tryPromise({
      try: () =>
        db.batch<{ state: string; expires_at: number; account_exists: number }>([
          ...(change.setting === "deny"
            ? endApprovals(
                db,
                owner,
                { connection: change.connectionId, account: change.accountId, tool: change.tool },
                now,
              )
            : []),
          db
            .prepare(
              change.setting !== "deny"
                ? `INSERT INTO permissions (connection_id,account_id,tool,ask) SELECT ?1,?2,?3,${change.setting === "ask" ? 1 : 0} WHERE ${guard} ON CONFLICT(connection_id,account_id,tool) DO UPDATE SET ask = excluded.ask`
                : `DELETE FROM permissions WHERE connection_id = ?1 AND account_id = ?2 AND tool = ?3 AND ${guard}`,
            )
            .bind(...values),
          db
            .prepare(`SELECT c.state, c.expires_at,
        EXISTS (SELECT 1 FROM accounts a WHERE a.id = ?2 AND a.generation = ?3 AND a.state = 'live') AS account_exists
        FROM connections c WHERE c.id = ?1 AND c.generation = ?3
        AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = ?3 AND o.email = ?4)`)
            .bind(change.connectionId, change.accountId, owner.generation, owner.email),
        ]),
      catch: () => new WriteUncertain(),
    });
    const row = results.at(-1)?.results[0];
    if (!row) return "not_found" as const;
    if (row.state !== "active" || Number(row.expires_at) <= now) return "already_ended" as const;
    return row.account_exists ? ("ok" as const) : ("not_found" as const);
  });

export const permissionsStatement = (
  db: D1Database,
  owner: Owner,
  connection: ConnectionId,
  now: number,
) =>
  db
    .prepare(`SELECT a.id AS account_id, p.tool, p.ask FROM accounts a
    JOIN permissions p ON p.account_id = a.id AND p.connection_id = ?1
    WHERE a.generation = ?2 AND ${permittedWhere({ connection: "?1", tool: "p.tool", now: "?4", ownerEmail: "?3" })}`)
    .bind(connection, owner.generation, owner.email, now);
export const decodePermissions = (
  rows: { account_id: AccountId; tool: AccountTool; ask: number }[],
) =>
  Object.fromEntries(
    rows.map((row) => [
      `${row.account_id}:${row.tool}`,
      row.ask === 1 ? ("ask" as const) : ("allow" as const),
    ]),
  );
