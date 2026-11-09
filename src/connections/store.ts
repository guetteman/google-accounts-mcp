import { Data, Effect } from "effect";
import { first, Unavailable } from "../db";
import type { Owner, OwnerEmail } from "../owner/owner";
import {
  APP_LABELS,
  type ActiveConnection,
  type App,
  type ConnectionId,
  type ConnectionName,
  type ConnectionView,
  type PendingGrant,
} from "./model";

export class NotRedeemable extends Data.TaggedError("NotRedeemable") {}
export class NotActive extends Data.TaggedError("NotActive") {}
export class WriteUncertain extends Data.TaggedError("WriteUncertain") {}
export const IDLE_MS = 90 * 24 * 60 * 60 * 1000;

/** Placeholders are supplied by the SQL caller, never by request data. Alias connections as c. */
export const activeWhere = ({ now, ownerEmail }: { now: string; ownerEmail: string }): string =>
  `c.state = 'active' AND c.expires_at > ${now} AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = c.generation AND o.email = ${ownerEmail})`;

export const redeem = (
  db: D1Database,
  input: { props: PendingGrant; grantId: string; app: App; ownerEmail: OwnerEmail; now: number },
) =>
  Effect.gen(function* () {
    const { props, grantId, app, ownerEmail, now } = input;
    const results = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          db
            .prepare(`INSERT INTO connections (id, generation, grant_id, app, name, state, created_at, expires_at)
        SELECT ?1, generation, ?2, ?3, ?4, 'active', ?5, ?6 FROM owner
        WHERE id = 1 AND state = 'pinned' AND generation = ?7 AND email = ?8
        ON CONFLICT(id) DO NOTHING`)
            .bind(
              props.connectionId,
              grantId,
              app,
              props.name,
              now,
              now + IDLE_MS,
              props.generation,
              ownerEmail,
            ),
          db
            .prepare(
              `SELECT c.id FROM connections c WHERE c.id = ?1 AND c.grant_id = ?2 AND c.generation = ?3 AND ${activeWhere({ now: "?4", ownerEmail: "?5" })}`,
            )
            .bind(props.connectionId, grantId, props.generation, now, ownerEmail),
        ]),
      catch: () => new Unavailable(),
    });
    if (!results[1]?.results.length) return yield* Effect.fail(new NotRedeemable());
  });
export const touchRefresh = (
  db: D1Database,
  input: { connectionId: ConnectionId; grantId: string; ownerEmail: OwnerEmail; now: number },
) =>
  Effect.gen(function* () {
    const { connectionId, grantId, ownerEmail, now } = input;
    const row = yield* first(
      db,
      `UPDATE connections AS c SET expires_at = ?1 WHERE c.id = ?2 AND c.grant_id = ?3 AND ${activeWhere({ now: "?4", ownerEmail: "?5" })} RETURNING id`,
      [now + IDLE_MS, connectionId, grantId, now, ownerEmail],
    );
    if (!row) return yield* Effect.fail(new NotActive());
  });
export const touchCall = (
  db: D1Database,
  input: { connectionId: ConnectionId; ownerEmail: OwnerEmail; now: number },
) =>
  Effect.gen(function* () {
    const { connectionId, ownerEmail, now } = input;
    const row = yield* first<{ app: App }>(
      db,
      `UPDATE connections AS c SET last_used_at = ?1 WHERE c.id = ?2 AND ${activeWhere({ now: "?1", ownerEmail: "?3" })} RETURNING app`,
      [now, connectionId, ownerEmail],
    );
    if (!row) return yield* Effect.fail(new NotActive());
    return { connectionId, app: row.app } satisfies ActiveConnection;
  });
interface Row {
  id: ConnectionId;
  name: string;
  app: App;
  state: "active" | "revoked";
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}
function date(value: number, now: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(new Date(value).getUTCFullYear() === new Date(now).getUTCFullYear()
      ? {}
      : { year: "numeric" }),
    timeZone: "UTC",
  }).format(value);
}
export const listConnections = (db: D1Database, owner: Owner, now: number) =>
  Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<ConnectionView>> => {
      const { results } = await db
        .prepare(`SELECT c.* FROM connections c WHERE c.generation = ?1
      AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = c.generation AND o.email = ?2)
      ORDER BY CASE WHEN c.state = 'active' AND c.expires_at > ?3 THEN 0 ELSE 1 END,
      CASE WHEN c.state = 'active' AND c.expires_at > ?3 THEN c.created_at ELSE COALESCE(c.revoked_at, c.expires_at) END DESC, c.id`)
        .bind(owner.generation, owner.email, now)
        .all<Row>();
      return results.map((r) => ({
        id: r.id,
        name: r.name,
        appLabel: APP_LABELS[r.app],
        status:
          r.state === "revoked"
            ? { kind: "revoked", on: date(r.revoked_at!, now) }
            : r.expires_at <= now
              ? { kind: "expired", on: date(r.expires_at, now) }
              : { kind: "active" },
        lastUsed: r.last_used_at === null ? "Never" : date(r.last_used_at, now),
        created: date(r.created_at, now),
      }));
    },
    catch: () => new Unavailable(),
  });
const action = (
  db: D1Database,
  owner: Owner,
  id: ConnectionId,
  now: number,
  change: { kind: "rename"; name: ConnectionName } | { kind: "revoke" },
) =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `UPDATE connections AS c SET ${change.kind === "rename" ? "name = ?1" : "state = 'revoked', revoked_at = ?1"} WHERE c.id = ?2 AND c.generation = ?3 AND ${activeWhere({ now: "?4", ownerEmail: "?5" })} RETURNING grant_id`,
          )
          .bind(
            change.kind === "rename" ? change.name : now,
            id,
            owner.generation,
            now,
            owner.email,
          )
          .first<{ grant_id: string }>(),
      catch: () => new WriteUncertain(),
    });
    if (row) return { grantId: row.grant_id };
    const ended = yield* first(
      db,
      `SELECT c.id FROM connections c WHERE c.id = ?1 AND c.generation = ?2
    AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = c.generation AND o.email = ?3)`,
      [id, owner.generation, owner.email],
    );
    return ended ? ("already_ended" as const) : ("not_found" as const);
  });
export const renameConnection = (
  db: D1Database,
  owner: Owner,
  id: ConnectionId,
  name: ConnectionName,
  now: number,
) =>
  action(db, owner, id, now, { kind: "rename", name }).pipe(
    Effect.map((result) => (typeof result === "string" ? result : ("ok" as const))),
  );
export const revokeConnection = (db: D1Database, owner: Owner, id: ConnectionId, now: number) =>
  action(db, owner, id, now, { kind: "revoke" });
