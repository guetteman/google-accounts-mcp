import { Effect } from "effect";
import { first, Unavailable, WriteUncertain } from "../db";
import type { Owner } from "../owner/owner";
import type { Name } from "../names";
import type { Sealed } from "../seal";
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
const ownerGuard =
  "a.generation = ?2 AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = a.generation AND o.email = ?3)";
export const credentialStatement = (db: D1Database, owner: Owner, id: AccountId) =>
  db
    .prepare(
      `SELECT a.id, a.email, a.version, a.health, a.blocked_until, a.refresh_token, a.access_token, a.access_expires_at FROM accounts a WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard}`,
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
export const listAccounts = (db: D1Database, owner: Owner) =>
  Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<AccountView>> => {
      const { results } = await db
        .prepare(
          `SELECT a.id, a.name, a.email, a.hd, a.health, a.scopes FROM accounts a WHERE a.state = 'live' AND a.generation = ?1 AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = a.generation AND o.email = ?2) ORDER BY a.created_at, a.id`,
        )
        .bind(owner.generation, owner.email)
        .all<{
          id: string;
          name: string;
          email: string;
          hd: string | null;
          health: Health;
          scopes: string;
        }>();
      return results.map((row) => {
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
          status: accountStatus(row.health, parseGrantedScopes(scopes.join(" "))),
        };
      });
    },
    catch: () => new Unavailable(),
  });
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
      `SELECT a.id, a.sub, a.email, a.name, a.state, a.version FROM accounts a WHERE a.${column} = ?1 AND a.state = 'live' AND ${ownerGuard}`,
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
    if (results[0]!.results.length) return { connected: grant.identity.email };
    const same = results[1]!.results[0];
    if (same) return { alreadyConnected: same.email };
    const clash = results[2]!.results[0];
    if (clash) return { addressTaken: { address: clash.email, name: clash.name } };
    return "owner_changed" as const;
  });
export const reconnectTarget = (db: D1Database, owner: Owner, id: AccountId) =>
  first<{ id: AccountId; version: number; email: string }>(
    db,
    `SELECT a.id, a.version, a.email FROM accounts a WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard}`,
    [id, owner.generation, owner.email],
  );
export const reconnectAccount = (
  db: D1Database,
  owner: Owner,
  target: { id: AccountId; version: number },
  grant: SealedGrant,
  _now: number,
) =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise({
      try: () =>
        db.batch<IdentityRow>([
          db
            .prepare(
              `UPDATE accounts AS a SET email = ?4, hd = ?5, scopes = ?6, refresh_token = ?7, access_token = ?8, access_expires_at = ?9, health = 'ready', blocked_until = NULL, version = version + 1 WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard} AND a.sub = ?10 AND a.version = ?11 AND NOT EXISTS (SELECT 1 FROM accounts other WHERE other.state = 'live' AND other.email = ?4 AND other.id <> a.id) RETURNING id`,
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
              `SELECT a.id, a.sub, a.email, a.name, a.state, a.version FROM accounts a WHERE a.id = ?1 AND ${ownerGuard}`,
            )
            .bind(target.id, owner.generation, owner.email),
          byIdentity(db, owner, "email", grant.identity.email),
        ]),
      catch: () => new Unavailable(),
    });
    if (results[0]!.results.length) return { reconnected: grant.identity.email };
    const row = results[1]!.results[0];
    if (row && row.sub !== grant.identity.sub)
      return { wrongAccount: { signedIn: grant.identity.email, target: row.email } };
    if (!row || row.state !== "live" || row.version !== target.version)
      return { changed: row?.email ?? grant.identity.email };
    const clash = results[2]!.results[0];
    if (clash) return { addressTaken: { address: clash.email, name: clash.name } };
    return { changed: row.email };
  });
export const renameAccount = (
  db: D1Database,
  owner: Owner,
  id: AccountId,
  name: Name,
  _now: number,
) =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `UPDATE accounts AS a SET name = ?4 WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard} RETURNING id`,
        )
        .bind(id, owner.generation, owner.email, name)
        .first(),
    catch: () => new WriteUncertain(),
  }).pipe(Effect.map((row) => (row ? ("ok" as const) : ("not_found" as const))));
export const removalTarget = (db: D1Database, owner: Owner, id: AccountId) =>
  first<{ email: string; refreshToken: Sealed | null }>(
    db,
    `SELECT a.email, a.refresh_token AS refreshToken FROM accounts a WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard}`,
    [id, owner.generation, owner.email],
  );
export const removeAccount = (db: D1Database, owner: Owner, id: AccountId, now: number) =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `UPDATE accounts AS a SET state = 'removed', removed_at = ?4, refresh_token = NULL, access_token = NULL, access_expires_at = NULL, blocked_until = NULL WHERE a.id = ?1 AND a.state = 'live' AND ${ownerGuard} RETURNING email`,
        )
        .bind(id, owner.generation, owner.email, now)
        .first<{ email: string }>(),
    catch: () => new WriteUncertain(),
  }).pipe(Effect.map((row) => (row ? { removed: row.email } : ("not_found" as const))));

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
    [token, expiresAt],
    "AND a.health <> 'needs_reconnect'",
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
