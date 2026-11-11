import { endApprovals, changeGuard } from "../approvals/store";
import type { CallContext } from "../mcp/call";
import type { AccountTool } from "../mcp/tools";
import { permittedWhere } from "../permissions/store";
import type { OwnerEmail } from "../owner/owner";
import { Effect } from "effect";
import { first, Unavailable, WriteUncertain } from "../db";
import type { Owner } from "../owner/owner";
import type { Name } from "../names";
import { keyId, type Sealed } from "../seal";
import type { TokenKey } from "../config";
import { parseGrantedScopes, type Grant } from "../google/client";
import {
  accountStatus,
  decodeCredential,
  parseAccountId,
  type AccountId,
  type AccountView,
  type Credential,
  type Health,
} from "./model";

export interface SealedGrant extends Omit<Grant, "refreshToken" | "accessToken"> {
  readonly id: AccountId;
  readonly refreshToken: Sealed;
  readonly accessToken: Sealed;
}
const ownerGuard = (generation = "?2", email = "?3") =>
  `a.generation = ${generation} AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = a.generation AND o.email = ${email})`;
export const credentialStatement = (db: D1Database, owner: Owner, id: AccountId) =>
  db
    .prepare(
      `SELECT a.id, a.email, a.version, a.health, a.blocked_until, a.refresh_token, a.access_token, a.access_expires_at FROM accounts a WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard()}`,
    )
    .bind(id, owner.generation, owner.email);
export const loadCredential = (db: D1Database, owner: Owner, id: AccountId) =>
  Effect.tryPromise({
    try: () => credentialStatement(db, owner, id).first<unknown>(),
    catch: () => new Unavailable(),
  }).pipe(
    Effect.flatMap((row) => {
      if (row === null) return Effect.succeed(null);
      const credential = decodeCredential(row);
      return credential ? Effect.succeed(credential) : Effect.fail(new Unavailable());
    }),
  );
// Lists expose only key prefixes, never token ciphertext.
const viewColumns = `a.id, a.name, a.email, a.hd, a.health, a.scopes,
  substr(a.refresh_token,1,20) AS refresh_key, substr(a.access_token,1,20) AS access_key`;
interface ViewRow {
  id: string;
  name: string;
  email: string;
  hd: string | null;
  health: Health;
  scopes: string;
  refresh_key: string | null;
  access_key: string | null;
}
function decodeView(row: ViewRow, prefix: string): AccountView {
  const id = parseAccountId(row.id);
  if (!id) throw new Error("Invalid account ID");
  const scopes: unknown = JSON.parse(row.scopes);
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string"))
    throw new Error("Invalid account scopes");
  return {
    id,
    name: row.name,
    email: row.email,
    workspace: row.hd !== null,
    status: accountStatus(
      row.health,
      parseGrantedScopes(scopes.join(" ")),
      [row.refresh_key, row.access_key].every((value) => value === null || value === prefix),
    ),
  };
}
const listing = (db: D1Database, owner: Owner, where = "", values: (string | number)[] = []) =>
  db
    .prepare(`SELECT ${viewColumns} FROM accounts a WHERE a.state = 'live'
    AND ${ownerGuard("?1", "?2")} ${where} ORDER BY a.created_at, a.id`)
    .bind(owner.generation, owner.email, ...values);
export const accountsStatement = (db: D1Database, owner: Owner) => listing(db, owner);
export const decodeAccounts = async (results: ViewRow[], tokenKey: TokenKey) => {
  const prefix = `v1.${await keyId(tokenKey)}.`;
  return results.map((row) => decodeView(row, prefix));
};
const decodeListing = (statement: D1PreparedStatement, tokenKey: TokenKey) =>
  Effect.tryPromise({
    try: async () => decodeAccounts((await statement.all<ViewRow>()).results, tokenKey),
    catch: () => new Unavailable(),
  });
export const listAccounts = (db: D1Database, owner: Owner, tokenKey: TokenKey) =>
  decodeListing(listing(db, owner), tokenKey);
export const listVisibleAccounts = (ctx: CallContext) =>
  decodeListing(
    listing(
      ctx.db,
      ctx.owner,
      `AND ${permittedWhere({ connection: "?3", now: "?4", ownerEmail: "?2" })}`,
      [ctx.connection.connectionId, ctx.now()],
    ),
    ctx.config.tokenKey,
  );
export const allowedAccountColumns = `${viewColumns}, a.version, a.blocked_until, a.refresh_token, a.access_token, a.access_expires_at`;
export const allowedAccountStatement = (ctx: CallContext, tool: AccountTool, account: OwnerEmail) =>
  ctx.db
    .prepare(`SELECT ${allowedAccountColumns},
    (SELECT p.ask FROM permissions p WHERE p.account_id = a.id AND p.connection_id = ?4 AND p.tool = ?5) AS ask
    FROM accounts a WHERE a.email = ?3 AND ${ownerGuard("?1", "?2")}
    AND ${permittedWhere({ connection: "?4", tool: "?5", now: "?6", ownerEmail: "?2" })}`)
    .bind(
      ctx.owner.generation,
      ctx.owner.email,
      account,
      ctx.connection.connectionId,
      tool,
      ctx.now(),
    );
export const decodeAllowedAccount = async (row: unknown, tokenKey: TokenKey) => {
  const credential = decodeCredential(row);
  if (!credential) throw new Error("Invalid allowed credential");
  const view = decodeView(row as ViewRow, `v1.${await keyId(tokenKey)}.`);
  return { credential, status: view.status };
};
interface IdentityRow {
  id: AccountId;
  sub: string;
  email: string;
  name: string;
  state: string;
  version: number;
}
const byIdentity = (db: D1Database, owner: Owner, column: "sub" | "email", value: string) =>
  db
    .prepare(
      `SELECT a.id, a.sub, a.email, a.name, a.state, a.version FROM accounts a WHERE a.${column} = ?1 AND a.state = 'live' AND ${ownerGuard()}`,
    )
    .bind(value, owner.generation, owner.email);
export const addAccount = (db: D1Database, owner: Owner, grant: SealedGrant, now: number) =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () =>
        db.batch<IdentityRow>([
          db
            .prepare(`INSERT INTO accounts (id,generation,sub,email,name,hd,state,created_at,version,scopes,health,refresh_token,access_token,access_expires_at)
 SELECT ?1,generation,?2,?3,substr(?3,1,100),?4,'live',?5,1,?6,'ready',?7,?8,?9 FROM owner WHERE id = 1 AND state = 'pinned' AND generation = ?10 AND email = ?11 ON CONFLICT DO NOTHING RETURNING id`)
            .bind(
              grant.id,
              grant.identity.sub,
              grant.identity.email,
              grant.identity.hd,
              now,
              JSON.stringify(grant.scopes),
              grant.refreshToken,
              grant.accessToken,
              grant.expiresAt,
              owner.generation,
              owner.email,
            ),
          byIdentity(db, owner, "sub", grant.identity.sub),
          byIdentity(db, owner, "email", grant.identity.email),
        ]),
      catch: () => new Unavailable(),
    });
    if (results[0]!.results.length)
      return { _tag: "Connected", address: grant.identity.email } as const;
    const same = results[1]!.results[0];
    if (same) return { _tag: "AlreadyConnected", address: same.email } as const;
    const clash = results[2]!.results[0];
    if (clash) return { _tag: "AddressTaken", address: clash.email, name: clash.name } as const;
    return { _tag: "OwnerChanged" } as const;
  });
export const reconnectTarget = (db: D1Database, owner: Owner, id: AccountId) =>
  first<{ id: AccountId; version: number; email: string }>(
    db,
    `SELECT a.id, a.version, a.email FROM accounts a WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard()}`,
    [id, owner.generation, owner.email],
  );
export const reconnectAccount = (
  db: D1Database,
  owner: Owner,
  target: { id: AccountId; version: number },
  grant: SealedGrant,
) =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () =>
        db.batch<IdentityRow>([
          db
            .prepare(
              `UPDATE accounts AS a SET email = ?4, hd = ?5, scopes = ?6, refresh_token = ?7, access_token = ?8, access_expires_at = ?9, health = 'ready', blocked_until = NULL, version = version + 1 WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard()} AND a.sub = ?10 AND a.version = ?11 AND NOT EXISTS (SELECT 1 FROM accounts other WHERE other.state = 'live' AND other.email = ?4 AND other.id <> a.id) RETURNING id`,
            )
            .bind(
              target.id,
              owner.generation,
              owner.email,
              grant.identity.email,
              grant.identity.hd,
              JSON.stringify(grant.scopes),
              grant.refreshToken,
              grant.accessToken,
              grant.expiresAt,
              grant.identity.sub,
              target.version,
            ),
          db
            .prepare(
              `SELECT a.id, a.sub, a.email, a.name, a.state, a.version FROM accounts a WHERE a.id = ?1 AND ${ownerGuard()}`,
            )
            .bind(target.id, owner.generation, owner.email),
          byIdentity(db, owner, "email", grant.identity.email),
        ]),
      catch: () => new Unavailable(),
    });
    if (results[0]!.results.length)
      return { _tag: "Reconnected", address: grant.identity.email } as const;
    const row = results[1]!.results[0];
    if (row && row.sub !== grant.identity.sub)
      return { _tag: "WrongAccount", signedIn: grant.identity.email, target: row.email } as const;
    if (!row || row.state !== "live" || row.version !== target.version)
      return { _tag: "Changed", address: row?.email ?? grant.identity.email } as const;
    const clash = results[2]!.results[0];
    return clash
      ? ({ _tag: "AddressTaken", address: clash.email, name: clash.name } as const)
      : ({ _tag: "Changed", address: row.email } as const);
  });
export const renameAccount = (db: D1Database, owner: Owner, id: AccountId, name: Name) =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `UPDATE accounts AS a SET name = ?4 WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard()} RETURNING id`,
        )
        .bind(id, owner.generation, owner.email, name)
        .first(),
    catch: () => new WriteUncertain(),
  }).pipe(
    Effect.map((row) => (row ? { _tag: "Renamed" as const } : { _tag: "NotFound" as const })),
  );
export const removalTarget = (db: D1Database, owner: Owner, id: AccountId) =>
  first<{ email: string; refreshToken: Sealed | null }>(
    db,
    `SELECT a.email, a.refresh_token AS refreshToken FROM accounts a WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard()}`,
    [id, owner.generation, owner.email],
  );
export const removeAccount = (db: D1Database, owner: Owner, id: AccountId, now: number) =>
  Effect.tryPromise({
    try: async () => {
      const values = [now, id, owner.generation, owner.email];
      const batch = await db.batch<{ email: string }>([
        ...endApprovals(db, owner, { account: id }, now),
        db
          .prepare(
            `UPDATE accounts AS a SET state = 'removed', removed_at = ?1, refresh_token = NULL, access_token = NULL, access_expires_at = NULL, blocked_until = NULL WHERE a.id = ?2 AND ${changeGuard("account", { account: "?2", generation: "?3", ownerEmail: "?4", now: "?1" })} RETURNING email`,
          )
          .bind(...values),
      ]);
      return batch.at(-1)!.results[0] ?? null;
    },
    catch: () => new WriteUncertain(),
  }).pipe(
    Effect.map((row) =>
      row ? { _tag: "Removed" as const, address: row.email } : { _tag: "NotFound" as const },
    ),
  );

// Only reconnect advances version. Concurrent refreshes of Google's non-rotating token can both win.
const tokenWrite = (
  db: D1Database,
  account: Credential,
  change: string,
  values: (string | number | null)[] = [],
  guard = "",
) =>
  first(
    db,
    `UPDATE accounts AS a SET ${change} WHERE a.id = ?1 AND a.state = 'live' AND a.version = ?2 ${guard} RETURNING id`,
    [account.id, account.version, ...values],
  ).pipe(Effect.map((row) => row !== null));
export const storeRefreshed = (
  db: D1Database,
  account: Credential,
  token: Sealed,
  expiresAt: number,
) =>
  tokenWrite(
    db,
    account,
    "access_token = ?3, access_expires_at = ?4, health = 'ready', blocked_until = NULL",
    [token, expiresAt, account.health, account.blockedUntil],
    "AND a.health = ?5 AND a.blocked_until IS ?6",
  );
export const markNeedsReconnect = (db: D1Database, account: Credential) =>
  tokenWrite(
    db,
    account,
    "health = 'needs_reconnect', refresh_token = NULL, access_token = NULL, access_expires_at = NULL, blocked_until = NULL",
  );
export const markBlocked = (db: D1Database, account: Credential, now: number) =>
  tokenWrite(
    db,
    account,
    "health = 'blocked_by_admin', blocked_until = ?3, access_token = NULL, access_expires_at = NULL",
    [now + 600000, account.accessToken, account.blockedUntil],
    "AND a.health <> 'needs_reconnect' AND a.access_token IS ?4 AND a.blocked_until IS ?5",
  );
export const claimBlockSlot = (db: D1Database, account: Credential, now: number) =>
  tokenWrite(
    db,
    account,
    "blocked_until = ?3",
    [now + 600000, account.blockedUntil, now],
    "AND a.health = 'blocked_by_admin' AND a.blocked_until = ?4 AND a.blocked_until <= ?5",
  );
